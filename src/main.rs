use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use serde_json::{Value, json};
use std::io::Read;
use std::path::PathBuf;
use std::time::Instant;

use gaze::embed::{AutoEmbedder, Embedder};
use gaze::envelope::{self, usage};
use gaze::store::{GLOBAL, NewNode, Scope, SearchOptions, Store};
use gaze::{daemon, hooks, import, ingest, mcp, paths, project, setup, text};

#[derive(Parser)]
#[command(name = "gaze", version, about = "El cerebro de cada proyecto: notas, reglas y búsqueda híbrida para agentes")]
struct Cli {
    #[arg(long, global = true, help = "Salida JSON (sobre de kit)")]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    #[command(about = "Guarda una nota (texto, @archivo o - para stdin)")]
    Remember {
        body: String,
        #[arg(long)]
        project: Option<String>,
        #[arg(long, default_value = "fact")]
        kind: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        pin: bool,
        #[arg(long)]
        until: Option<String>,
    },
    #[command(about = "Búsqueda híbrida (texto + vectores)")]
    Search {
        query: String,
        #[arg(long, conflicts_with = "all")]
        project: Option<String>,
        #[arg(long)]
        all: bool,
        #[arg(long)]
        kind: Option<String>,
        #[arg(long, default_value_t = 5)]
        limit: usize,
        #[arg(long, hide = true)]
        explain: bool,
    },
    #[command(about = "Muestra una nota y sus vecinos")]
    Show { id: String },
    #[command(about = "Reglas activas que se inyectan al iniciar sesión")]
    Rule {
        #[command(subcommand)]
        action: RuleAction,
    },
    #[command(about = "Enlaza dos notas")]
    Link { a: String, b: String },
    #[command(about = "Borra una nota")]
    Forget { id: String },
    #[command(about = "Mueve una nota o regla a otro proyecto o grupo")]
    Move {
        id: String,
        #[arg(long)]
        project: String,
    },
    #[command(about = "Grupos de proyectos que comparten reglas y notas")]
    Group {
        #[command(subcommand)]
        action: GroupAction,
    },
    #[command(about = "Grafo de notas y aristas")]
    Graph {
        #[arg(long)]
        project: Option<String>,
    },
    #[command(about = "Ingesta desde inkwell, recap o bita")]
    Ingest {
        #[arg(long, default_value = "all")]
        source: String,
    },
    #[command(about = "Importa memorias de otras herramientas")]
    Import {
        #[command(subcommand)]
        what: ImportWhat,
    },
    #[command(about = "Proyecto resuelto para un directorio")]
    Project {
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long)]
        refresh: bool,
    },
    #[command(about = "Estadísticas del cerebro y de lo inyectado")]
    Stats,
    #[command(about = "Capacidades para kit")]
    Capabilities,
    #[command(about = "Registra gaze en kit y crea la configuración")]
    Setup,
    #[command(about = "Quita el registro de kit (conserva los datos)")]
    Uninstall,
    #[command(about = "Servidor MCP por stdio")]
    Mcp,
    #[command(about = "Daemon que mantiene el modelo cargado")]
    Serve {
        #[arg(long)]
        idle_minutes: Option<u64>,
    },
    #[command(about = "Instala o quita el daemon de launchd")]
    Daemon {
        #[command(subcommand)]
        action: DaemonAction,
    },
    #[command(about = "Hooks de Claude Code (session-start, prompt, harvest)")]
    Hook { event: String },
    #[command(about = "Recibe eventos de bita por stdin")]
    BitaHook,
    #[command(about = "Vuelve a calcular embeddings")]
    Reindex {
        #[arg(long)]
        all: bool,
    },
    #[command(hide = true)]
    HarvestRun {
        #[arg(long)]
        transcript: PathBuf,
        #[arg(long)]
        session: String,
        #[arg(long)]
        cwd: PathBuf,
    },
}

#[derive(Subcommand)]
enum RuleAction {
    Add {
        text: String,
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        until: Option<String>,
        #[arg(long)]
        pin: bool,
        #[arg(long)]
        global: bool,
    },
    Ls {
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        all: bool,
    },
    Rm {
        id: String,
    },
}

#[derive(Subcommand)]
enum GroupAction {
    Set { name: String, projects: Vec<String> },
    Ls,
    Rm { name: String },
}

#[derive(Subcommand)]
enum ImportWhat {
    ClaudeMemory {
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        root: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
enum DaemonAction {
    Install,
    Uninstall,
    Status,
}

fn command_name(command: &Command) -> &'static str {
    match command {
        Command::Remember { .. } => "remember",
        Command::Search { .. } => "search",
        Command::Show { .. } => "show",
        Command::Rule { action } => match action {
            RuleAction::Add { .. } => "rule add",
            RuleAction::Ls { .. } => "rule ls",
            RuleAction::Rm { .. } => "rule rm",
        },
        Command::Link { .. } => "link",
        Command::Forget { .. } => "forget",
        Command::Move { .. } => "move",
        Command::Group { action } => match action {
            GroupAction::Set { .. } => "group set",
            GroupAction::Ls => "group ls",
            GroupAction::Rm { .. } => "group rm",
        },
        Command::Graph { .. } => "graph",
        Command::Ingest { .. } => "ingest",
        Command::Import { .. } => "import claude-memory",
        Command::Project { .. } => "project",
        Command::Stats => "stats",
        Command::Capabilities => "capabilities",
        Command::Setup => "setup",
        Command::Uninstall => "uninstall",
        Command::Mcp => "mcp",
        Command::Serve { .. } => "serve",
        Command::Daemon { .. } => "daemon",
        Command::Hook { .. } => "hook",
        Command::BitaHook => "bita-hook",
        Command::Reindex { .. } => "reindex",
        Command::HarvestRun { .. } => "harvest-run",
    }
}

struct Output {
    data: Value,
    human: String,
    meta: Option<Value>,
}

impl Output {
    fn new(data: Value, human: impl Into<String>) -> Self {
        Self { data, human: human.into(), meta: None }
    }
}

fn cwd() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
}

fn read_body(body: &str) -> Result<String> {
    if body == "-" {
        let mut raw = String::new();
        std::io::stdin().read_to_string(&mut raw)?;
        return Ok(raw);
    }
    if let Some(path) = body.strip_prefix('@') {
        return std::fs::read_to_string(path).with_context(|| format!("leer {path}"));
    }
    Ok(body.to_string())
}

fn embedder() -> AutoEmbedder {
    AutoEmbedder::new(true)
}

fn run(command: Command) -> Result<Output> {
    match command {
        Command::Remember { body, project, kind, title, pin, until } => {
            let store = Store::open_default()?;
            let project = project::explicit_or_cwd(&store, project.as_deref(), &cwd())?;
            let outcome = store.remember(
                &embedder(),
                NewNode { project, kind, title, body: read_body(&body)?, source: "user".into(), pinned: pin, until, ..Default::default() },
                true,
            )?;
            let verb = match outcome.action {
                "created" => "Guardada",
                "merged" => "Fusionada con una nota parecida",
                "updated" => "Actualizada",
                _ => "Sin cambios",
            };
            let human = format!("{verb}: [{}] {} ({} · {})", outcome.id, outcome.title, outcome.kind, outcome.project);
            Ok(Output::new(serde_json::to_value(&outcome)?, human))
        }
        Command::Search { query, project, all, kind, limit, explain } => {
            let store = Store::open_default()?;
            let scope = if all { Scope::All } else { Scope::Project(project::explicit_or_cwd(&store, project.as_deref(), &cwd())?) };
            let emb = embedder();
            let hits = store.search(Some(&emb as &dyn Embedder), &query, &scope, &SearchOptions { kind, limit, ..Default::default() })?;
            let human = if hits.is_empty() {
                "Sin resultados.".to_string()
            } else {
                hits.iter().map(|h| format!("[{}] {} ({} · {})\n    {}", h.id, h.title, h.kind, h.project, h.snippet)).collect::<Vec<_>>().join("\n")
            };
            let scope_label = match &scope {
                Scope::All => "all".to_string(),
                Scope::Project(p) => p.clone(),
            };
            let mut data = serde_json::to_value(&hits)?;
            if explain && let Some(items) = data.as_array_mut() {
                for (item, hit) in items.iter_mut().zip(&hits) {
                    item["similarity"] = json!(hit.similarity);
                    item["coverage"] = json!(hit.coverage);
                }
            }
            Ok(Output { data, human, meta: Some(json!({"scope": scope_label, "count": hits.len()})) })
        }
        Command::Show { id } => {
            let store = Store::open_default()?;
            let (node, neighbors) = store.show(&id)?;
            let mut human = format!(
                "[{}] {}\n{} · {} · {}{}\n\n{}",
                node.id,
                node.title,
                node.kind,
                node.project,
                node.source,
                if node.pinned { " · fijada" } else { "" },
                node.body
            );
            if !neighbors.is_empty() {
                human.push_str("\n\nVecinos:");
                for n in &neighbors {
                    human.push_str(&format!("\n  [{}] {} ({}, {})", n.id, n.title, n.kind, n.edge_kind));
                }
            }
            let mut data = serde_json::to_value(&node)?;
            data["neighbors"] = serde_json::to_value(&neighbors)?;
            Ok(Output::new(data, human))
        }
        Command::Rule { action } => {
            let store = Store::open_default()?;
            match action {
                RuleAction::Add { text, project, until, pin, global } => {
                    let project = if global { GLOBAL.to_string() } else { project::explicit_or_cwd(&store, project.as_deref(), &cwd())? };
                    let outcome = store.remember(
                        &embedder(),
                        NewNode { project, kind: "rule".into(), body: read_body(&text)?, source: "user".into(), pinned: pin, until, ..Default::default() },
                        true,
                    )?;
                    let human =
                        format!("Regla {}: [{}] en {}", if outcome.action == "created" { "agregada" } else { "actualizada" }, outcome.id, outcome.project);
                    Ok(Output::new(serde_json::to_value(&outcome)?, human))
                }
                RuleAction::Ls { project, all } => {
                    let rules = if all {
                        store.rules(None, true)?
                    } else {
                        let project = project::explicit_or_cwd(&store, project.as_deref(), &cwd())?;
                        store.rules(Some(&project), false)?
                    };
                    let human = if rules.is_empty() {
                        "Sin reglas.".to_string()
                    } else {
                        rules
                            .iter()
                            .map(|r| {
                                let until = r.until.as_ref().map(|u| format!(" · hasta {u}")).unwrap_or_default();
                                format!("[{}] {}{}{} — {}", r.id, r.project, if r.pinned { " · fijada" } else { "" }, until, text::one_line(&r.body))
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    };
                    let data: Vec<Value> = rules
                        .iter()
                        .map(|r| json!({"id": r.id, "project": r.project, "text": r.body, "pinned": r.pinned, "until": r.until, "updatedAt": r.updated_at}))
                        .collect();
                    Ok(Output::new(json!(data), human))
                }
                RuleAction::Rm { id } => {
                    let node = store.require(&id)?;
                    if node.kind != "rule" {
                        return Err(usage(format!("[{}] no es una regla, es {}", node.id, node.kind)));
                    }
                    store.forget(&node.id)?;
                    Ok(Output::new(json!({"id": node.id, "removed": true}), format!("Regla [{}] borrada.", node.id)))
                }
            }
        }
        Command::Link { a, b } => {
            let store = Store::open_default()?;
            let (first, second) = store.link(&a, &b)?;
            Ok(Output::new(
                json!({"src": first.id, "dst": second.id, "kind": "link"}),
                format!("Enlazadas: [{}] {} → [{}] {}", first.id, first.title, second.id, second.title),
            ))
        }
        Command::Forget { id } => {
            let store = Store::open_default()?;
            let node = store.forget(&id)?;
            Ok(Output::new(json!({"id": node.id, "removed": true}), format!("Borrada: [{}] {}", node.id, node.title)))
        }
        Command::Move { id, project: target } => {
            let store = Store::open_default()?;
            let target = project::project_for_name(&store, &target);
            let node = store.move_node(&embedder(), &id, &target)?;
            Ok(Output::new(json!({"id": node.id, "project": node.project}), format!("[{}] ahora está en {}", node.id, node.project)))
        }
        Command::Group { action } => {
            let store = Store::open_default()?;
            match action {
                GroupAction::Set { name, projects } => {
                    let name = text::slugify(&name);
                    if name.is_empty() || name == GLOBAL || projects.is_empty() {
                        return Err(usage("Uso: gaze group set <nombre> <proyecto>..."));
                    }
                    let members: Vec<String> = projects.iter().map(|p| project::project_for_name(&store, p)).filter(|p| p != GLOBAL).collect();
                    store.set_group(&name, &members)?;
                    Ok(Output::new(json!({"name": name, "projects": members}), format!("Grupo {name}: {}", members.join(", "))))
                }
                GroupAction::Ls => {
                    let groups = store.groups()?;
                    let human = if groups.is_empty() {
                        "Sin grupos.".to_string()
                    } else {
                        groups.iter().map(|(n, m)| format!("{n}: {}", m.join(", "))).collect::<Vec<_>>().join("\n")
                    };
                    let data: Vec<Value> = groups.iter().map(|(n, m)| json!({"name": n, "projects": m})).collect();
                    Ok(Output::new(json!(data), human))
                }
                GroupAction::Rm { name } => {
                    let name = text::slugify(&name);
                    let removed = store.remove_group(&name)?;
                    Ok(Output::new(
                        json!({"name": name, "removed": removed}),
                        if removed { format!("Grupo {name} borrado.") } else { format!("No existe el grupo {name}.") },
                    ))
                }
            }
        }
        Command::Graph { project } => {
            let store = Store::open_default()?;
            let graph = store.graph(project.as_deref())?;
            let human = format!("{} nodos, {} aristas", graph["nodes"].as_array().map_or(0, Vec::len), graph["edges"].as_array().map_or(0, Vec::len));
            Ok(Output::new(graph, human))
        }
        Command::Ingest { source } => {
            let store = Store::open_default()?;
            let emb = embedder();
            let mut reports = Vec::new();
            let started = Instant::now();
            if !["all", "inkwell", "recap", "bita"].contains(&source.as_str()) {
                return Err(usage("--source debe ser inkwell, recap, bita o all"));
            }
            if source == "all" || source == "inkwell" {
                reports.push(serde_json::to_value(ingest::ingest_inkwell(&store, &emb, &paths::inkwell_docs(), true, &project::bita_bin())?)?);
            }
            if source == "all" || source == "recap" {
                reports.push(serde_json::to_value(ingest::ingest_recap(&store, &emb)?)?);
            }
            if source == "bita" {
                reports.push(json!({"source": "bita", "note": "bita llega por eventos: gaze bita-hook (stop, amend, delete)"}));
            }
            let human = reports
                .iter()
                .map(|r| {
                    if let Some(note) = r["note"].as_str() {
                        return format!("{}: {note}", r["source"].as_str().unwrap_or_default());
                    }
                    format!(
                        "{}: {} revisados, {} nuevos, {} actualizados, {} sin cambios, {} quitados, {} con error",
                        r["source"].as_str().unwrap_or_default(),
                        r["scanned"],
                        r["created"],
                        r["updated"],
                        r["unchanged"],
                        r["removed"],
                        r["failed"]
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            Ok(Output { data: json!(reports), human, meta: Some(json!({"ms": started.elapsed().as_millis()})) })
        }
        Command::Import { what: ImportWhat::ClaudeMemory { dry_run, root } } => {
            let store = Store::open_default()?;
            let root = root.unwrap_or_else(paths::claude_projects);
            let emb = embedder();
            let result = import::run(&store, if dry_run { None } else { Some(&emb) }, &root, dry_run)?;
            let mut human = format!("{} memorias{}", result["total"], if dry_run { " (simulación)" } else { "" });
            if let Some(projects) = result["projects"].as_object() {
                for (project, kinds) in projects {
                    let parts: Vec<String> = kinds.as_object().map(|m| m.iter().map(|(k, v)| format!("{v} {k}")).collect()).unwrap_or_default();
                    human.push_str(&format!("\n  {project}: {}", parts.join(", ")));
                }
            }
            if let Some(actions) = result["actions"].as_object().filter(|a| !a.is_empty()) {
                let parts: Vec<String> = actions.iter().map(|(k, v)| format!("{v} {k}")).collect();
                human.push_str(&format!("\nResultado: {}", parts.join(", ")));
            }
            Ok(Output::new(result, human))
        }
        Command::Project { cwd: dir, refresh } => {
            let store = Store::open_default()?;
            let dir = dir.unwrap_or_else(cwd);
            let resolved = project::resolve(&store, &dir, refresh)?;
            let human = format!(
                "{}{}{} (fuente: {})",
                resolved.slug,
                resolved.name.as_ref().map(|n| format!(" · {n}")).unwrap_or_default(),
                resolved.key.as_ref().map(|k| format!(" · {k}")).unwrap_or_default(),
                resolved.source
            );
            Ok(Output::new(serde_json::to_value(&resolved)?, human))
        }
        Command::Stats => {
            let store = Store::open_default()?;
            let mut stats = store.stats()?;
            stats["daemon"] = daemon::status();
            let human = format!(
                "{} notas, {} aristas, {} fragmentos ({} sin embedding)\nInyectado: {} tokens en {} sesiones (promedio {} por sesión)\nDaemon: {}",
                stats["nodes"],
                stats["edges"],
                stats["chunks"],
                stats["unembedded"],
                stats["injection"]["tokens"],
                stats["injection"]["sessions"],
                stats["injection"]["avgTokensPerSession"],
                if stats["daemon"]["running"] == json!(true) { "corriendo" } else { "apagado" }
            );
            Ok(Output::new(stats, human))
        }
        Command::Capabilities => {
            let caps = setup::capabilities();
            let human = format!("gaze {}: {}", env!("CARGO_PKG_VERSION"), setup::CAPABILITIES.join(", "));
            Ok(Output::new(caps, human))
        }
        Command::Setup => {
            let result = setup::setup()?;
            let human = format!(
                "Registrado en kit: {}\nConfiguración: {}\nBase: {}\n\nFalta (no lo hago yo):\n  gaze daemon install\n  {}\n  {}\n  gaze import claude-memory --dry-run && gaze import claude-memory\n  gaze ingest",
                result["manifest"].as_str().unwrap_or_default(),
                result["config"].as_str().unwrap_or_default(),
                result["database"].as_str().unwrap_or_default(),
                setup::CLAUDE_STEPS[0],
                setup::CLAUDE_STEPS[1]
            );
            Ok(Output::new(result, human))
        }
        Command::Uninstall => {
            let result = setup::uninstall()?;
            let human = format!(
                "Registro de kit {}.\nLos datos se quedan en {}.\nPara terminar: gaze daemon uninstall && claude plugin uninstall gaze@gaze",
                if result["removed"] == json!(true) { "borrado" } else { "no existía" },
                result["kept"].as_str().unwrap_or_default()
            );
            Ok(Output::new(result, human))
        }
        Command::Daemon { action } => match action {
            DaemonAction::Install => {
                let result = daemon::install()?;
                Ok(Output::new(result.clone(), format!("Daemon instalado en launchd ({})", result["plist"].as_str().unwrap_or_default())))
            }
            DaemonAction::Uninstall => {
                let result = daemon::uninstall()?;
                Ok(Output::new(result, "Daemon quitado de launchd."))
            }
            DaemonAction::Status => {
                let status = daemon::status();
                let human = if status["running"] == json!(true) { format!("Corriendo (pid {})", status["pid"]) } else { "Apagado".to_string() };
                Ok(Output::new(status, human))
            }
        },
        Command::Reindex { all } => {
            let store = Store::open_default()?;
            let done = store.reindex(&embedder(), all)?;
            Ok(Output::new(json!({"reindexed": done}), format!("{done} notas con embeddings nuevos.")))
        }
        Command::Mcp | Command::Serve { .. } | Command::Hook { .. } | Command::BitaHook | Command::HarvestRun { .. } => unreachable!(),
    }
}

fn run_hook(event: &str) {
    if hooks::disabled() {
        return;
    }
    let input = hooks::read_input();
    let result = (|| -> Result<Option<Value>> {
        match event {
            "harvest" => {
                hooks::harvest(&input)?;
                Ok(None)
            }
            "session-start" | "prompt" => {
                let store = Store::open_default()?;
                if event == "session-start" { hooks::session_start(&store, &input) } else { hooks::prompt(&store, &input) }
            }
            _ => Ok(None),
        }
    })();
    match result {
        Ok(Some(output)) => println!("{output}"),
        Ok(None) => {}
        Err(error) => eprintln!("gaze hook {event}: {error:#}"),
    }
}

fn main() {
    let cli = Cli::parse();
    let json_mode = cli.json;
    match cli.command {
        Command::Hook { event } => return run_hook(&event),
        Command::Mcp => {
            let result = Store::open_default().and_then(|store| {
                let emb = embedder();
                let dir = std::env::var_os("CLAUDE_PROJECT_DIR").map(PathBuf::from).unwrap_or_else(cwd);
                mcp::Server { store: &store, embedder: &emb, cwd: dir }.run()
            });
            if let Err(error) = result {
                eprintln!("gaze mcp: {error:#}");
                std::process::exit(1);
            }
            return;
        }
        Command::Serve { idle_minutes } => {
            if let Err(error) = daemon::serve(idle_minutes) {
                eprintln!("gaze serve: {error:#}");
                std::process::exit(1);
            }
            return;
        }
        Command::BitaHook => {
            let input = hooks::read_input();
            let result = Store::open_default().and_then(|store| ingest::bita_event(&store, &embedder(), &input));
            match result {
                Ok(value) => println!("{} bita-hook {value}", text::now_iso()),
                Err(error) => {
                    eprintln!("{} bita-hook: {error:#}", text::now_iso());
                    std::process::exit(1);
                }
            }
            return;
        }
        Command::HarvestRun { transcript, session, cwd: dir } => {
            let result = Store::open_default().and_then(|store| hooks::harvest_run(&store, &embedder(), &transcript, &session, &dir));
            if let Err(error) = result {
                println!("{} harvest {session}: {error:#}", text::now_iso());
            }
            return;
        }
        _ => {}
    }
    let name = command_name(&cli.command);
    match run(cli.command) {
        Ok(output) => {
            if json_mode {
                println!("{}", envelope::success(name, output.data, output.meta));
            } else {
                println!("{}", output.human);
            }
        }
        Err(error) => {
            if json_mode {
                println!("{}", envelope::failure(name, &error));
            } else {
                eprintln!("error: {error:#}");
                if let Some(hint) = error.downcast_ref::<envelope::GazeError>().and_then(|e| e.hint.clone()) {
                    eprintln!("sugerencia: {hint}");
                }
            }
            std::process::exit(1);
        }
    }
}
