//! Git-based self update (mirrors `actualizar.ps1`): fetch, report what is new and fast-forward `main`.
//! Never runs npm, never forces, resets, stashes or rebases.

use crate::util::hidden_command;
use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};

const MAX_COMMITS: usize = 30;
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);
const LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
/// A merge rewrites the working tree; killing it halfway would leave a broken checkout.
const MERGE_TIMEOUT: Duration = Duration::from_secs(600);
const NO_GIT_REPO: &str = "Esta copia no está conectada a git, así que no se puede actualizar desde aquí. Descarga de nuevo el proyecto con git clone.";
const LOCK_HELD: &str = "Ya hay una búsqueda o actualización en curso. Espera a que termine.";

static BUSY: Mutex<()> = Mutex::new(());

/// Only a held lock means busy; a lock poisoned by an old panic is still free to use.
fn acquire() -> Result<MutexGuard<'static, ()>, String> {
    match BUSY.try_lock() {
        Ok(g) => Ok(g),
        Err(TryLockError::Poisoned(p)) => Ok(p.into_inner()),
        Err(TryLockError::WouldBlock) => Err(LOCK_HELD.to_string()),
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: String,
    pub subject: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: CommitInfo,
    pub latest: CommitInfo,
    pub behind: u32,
    pub ahead: u32,
    pub commits: Vec<CommitInfo>,
    /// Modified tracked files (untracked files are ignored).
    pub dirty: Vec<String>,
    pub branch: String,
    pub can_apply: bool,
    /// Why `can_apply` is false (also set when there is simply nothing new).
    pub blocked_reason: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub commits: Vec<CommitInfo>,
    pub current: CommitInfo,
    pub deps_changed: bool,
    pub rust_changed: bool,
}

#[derive(Debug)]
enum GitFail {
    Missing,
    Timeout,
    Exit(String),
}

fn git(root: &Path, args: &[&str], timeout: Duration) -> Result<String, GitFail> {
    let mut cmd = hidden_command("git");
    cmd.arg("-C").arg(root).args(["-c", "core.quotepath=off"]).args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0").env("GCM_INTERACTIVE", "never");
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { GitFail::Missing } else { GitFail::Exit(e.to_string()) }
    })?;
    let mut out = child.stdout.take().expect("piped stdout");
    let mut err = child.stderr.take().expect("piped stderr");
    let t_out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let t_err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(GitFail::Timeout);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(GitFail::Exit(e.to_string())),
        }
    };
    let stdout = t_out.join().unwrap_or_default();
    let stderr = t_err.join().unwrap_or_default();
    if status.success() { Ok(stdout.trim_end().to_string()) } else { Err(GitFail::Exit(stderr.trim().to_string())) }
}

/// Turns a git failure into a message a non-technical user can act on.
fn friendly(fail: &GitFail, what: &str) -> String {
    match fail {
        GitFail::Missing => "No encuentro git en este equipo. Instálalo y vuelve a intentarlo.".to_string(),
        GitFail::Timeout => format!("{what}: se acabó el tiempo de espera. Revisa tu conexión a internet e inténtalo de nuevo."),
        GitFail::Exit(stderr) => {
            let low = stderr.to_lowercase();
            let auth = ["authentication failed", "could not read username", "could not read password", "terminal prompts disabled", "permission denied", "repository not found", "403", "invalid credentials"];
            let net = ["could not resolve host", "unable to access", "failed to connect", "timed out", "network is unreachable", "connection reset", "could not connect"];
            if auth.iter().any(|m| low.contains(m)) {
                format!("{what}: GitHub no aceptó las credenciales. Inicia sesión de nuevo en git (Git Credential Manager) o pide acceso al repositorio.")
            } else if net.iter().any(|m| low.contains(m)) {
                format!("{what}: no hay conexión con GitHub. Revisa tu internet e inténtalo de nuevo.")
            } else if low.contains("not possible to fast-forward") || low.contains("diverging") {
                "No se puede actualizar sin mezclar: esta copia tiene cambios propios que no están en GitHub. Pide ayuda para resolverlo; no se tocó nada.".to_string()
            } else {
                format!("{what}: {stderr}")
            }
        }
    }
}

/// Files listed by git under "untracked working tree files would be overwritten".
fn untracked_conflicts(stderr: &str) -> Vec<String> {
    let mut lines = stderr.lines().skip_while(|l| !l.contains("untracked working tree files would be overwritten"));
    lines.next();
    lines.take_while(|l| l.starts_with('\t') || l.starts_with(' ')).map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()
}

/// Errors of the merge step: adds advice for files in the way and for locked files.
fn friendly_merge(fail: &GitFail) -> String {
    if let GitFail::Exit(stderr) = fail {
        let files = untracked_conflicts(stderr);
        if !files.is_empty() {
            return format!("Hay archivos en el proyecto que chocan con la actualización: {}. Muévelos o bórralos y vuelve a intentarlo.", files.join(", "));
        }
        let low = stderr.to_lowercase();
        if ["index.lock", "unable to unlink", "permission denied"].iter().any(|m| low.contains(m)) {
            return "No pude actualizar porque hay archivos en uso. Cierra la app, el calentamiento y los pods, y usa actualizar.ps1.".to_string();
        }
    }
    friendly(fail, "No pude actualizar")
}

fn parse_commit(line: &str) -> CommitInfo {
    let (sha, subject) = line.split_once('\t').unwrap_or((line, ""));
    CommitInfo { sha: sha.trim().to_string(), subject: subject.trim().to_string() }
}

fn commit_at(root: &Path, rev: &str) -> Result<CommitInfo, String> {
    git(root, &["log", "-1", "--format=%h%x09%s", rev], LOCAL_TIMEOUT)
        .map(|s| parse_commit(&s))
        .map_err(|f| friendly(&f, "No pude leer la versión"))
}

fn commits_between(root: &Path, range: &str) -> Result<Vec<CommitInfo>, String> {
    let max = format!("-n{MAX_COMMITS}");
    git(root, &["log", &max, "--format=%h%x09%s", range], LOCAL_TIMEOUT)
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).map(parse_commit).collect())
        .map_err(|f| friendly(&f, "No pude leer los cambios"))
}

fn count(root: &Path, range: &str) -> Result<u32, String> {
    git(root, &["rev-list", "--count", range], LOCAL_TIMEOUT)
        .map_err(|f| friendly(&f, "No pude contar los cambios"))
        .map(|s| s.parse().unwrap_or(0))
}

fn dirty_files(root: &Path) -> Result<Vec<String>, String> {
    git(root, &["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"], LOCAL_TIMEOUT)
        .map(|s| s.lines().filter(|l| l.len() > 3).map(|l| l[3..].trim().to_string()).collect())
        .map_err(|f| friendly(&f, "No pude revisar los cambios locales"))
}

fn branch_name(root: &Path) -> Result<String, String> {
    git(root, &["rev-parse", "--abbrev-ref", "HEAD"], LOCAL_TIMEOUT).map_err(|f| friendly(&f, "No pude leer la rama"))
}

fn ensure_repo(root: &Path) -> Result<(), String> {
    if root.join(".git").exists() { Ok(()) } else { Err(NO_GIT_REPO.to_string()) }
}

fn fetch(root: &Path) -> Result<(), String> {
    git(root, &["fetch", "origin", "main"], FETCH_TIMEOUT)
        .map(|_| ())
        .map_err(|f| friendly(&f, "No pude buscar actualizaciones"))
}

fn why_blocked(branch: &str, dirty: &[String], ahead: u32, behind: u32) -> Option<String> {
    if branch != "main" {
        Some(format!("Estás en la rama «{branch}», no en main: no se actualiza desde aquí."))
    } else if !dirty.is_empty() {
        Some(format!("Hay {} archivo(s) del proyecto con cambios locales; guárdalos o descártalos antes de actualizar.", dirty.len()))
    } else if ahead > 0 {
        Some("Esta copia tiene cambios propios que no están en GitHub; no se actualiza desde aquí.".to_string())
    } else if behind == 0 {
        Some("No hay nada que actualizar.".to_string())
    } else {
        None
    }
}

pub fn check(root: &Path) -> Result<UpdateStatus, String> {
    let _guard = acquire()?;
    ensure_repo(root)?;
    fetch(root)?;
    let branch = branch_name(root)?;
    let dirty = dirty_files(root)?;
    let behind = count(root, "HEAD..origin/main")?;
    let ahead = count(root, "origin/main..HEAD")?;
    let commits = if behind > 0 { commits_between(root, "HEAD..origin/main")? } else { Vec::new() };
    let blocked_reason = why_blocked(&branch, &dirty, ahead, behind);
    Ok(UpdateStatus {
        current: commit_at(root, "HEAD")?,
        latest: commit_at(root, "origin/main")?,
        behind,
        ahead,
        commits,
        dirty,
        branch,
        can_apply: blocked_reason.is_none(),
        blocked_reason,
    })
}

pub fn apply(root: &Path) -> Result<ApplyReport, String> {
    let _guard = acquire()?;
    ensure_repo(root)?;
    let branch = branch_name(root)?;
    let dirty = dirty_files(root)?;
    fetch(root)?;
    let behind = count(root, "HEAD..origin/main")?;
    if let Some(reason) = why_blocked(&branch, &dirty, 0, behind) {
        return Err(reason);
    }
    let old = git(root, &["rev-parse", "HEAD"], LOCAL_TIMEOUT).map_err(|f| friendly(&f, "No pude leer la versión"))?;
    git(root, &["merge", "--ff-only", "--no-autostash", "--no-edit", "origin/main"], MERGE_TIMEOUT).map_err(|f| friendly_merge(&f))?;
    let range = format!("{old}..HEAD");
    let changed = git(root, &["diff", "--name-only", &old, "HEAD"], LOCAL_TIMEOUT)
        .map_err(|f| friendly(&f, "Se actualizó, pero no pude revisar qué cambió"))?;
    let files: Vec<&str> = changed.lines().map(str::trim).collect();
    Ok(ApplyReport {
        commits: commits_between(root, &range)?,
        current: commit_at(root, "HEAD")?,
        deps_changed: files.iter().any(|f| *f == "app/package-lock.json" || *f == "engines/warmup/package-lock.json"),
        rust_changed: files.iter().any(|f| f.starts_with("app/src-tauri/")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::lock;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Tests share the module-level lock, so they run one at a time.
    static SERIAL: Mutex<()> = Mutex::new(());
    static N: AtomicU32 = AtomicU32::new(0);

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    struct Sandbox {
        base: PathBuf,
        a: PathBuf,
        b: PathBuf,
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    fn commit_file(dir: &Path, rel: &str, content: &str, msg: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, content).unwrap();
        sh(dir, &["add", "-A"]);
        sh(dir, &["commit", "-q", "-m", msg]);
    }

    /// A bare "origin" plus two clones (a = the app copy, b = a second developer), both on main with one shared commit.
    fn sandbox() -> Sandbox {
        let base = std::env::temp_dir().join(format!("updater-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let origin = base.join("origin.git");
        std::fs::create_dir_all(&origin).unwrap();
        sh(&origin, &["init", "-q", "--bare", "-b", "main"]);
        let a = base.join("a");
        let b = base.join("b");
        sh(&base, &["clone", "-q", origin.to_str().unwrap(), a.to_str().unwrap()]);
        sh(&a, &["checkout", "-q", "-B", "main"]);
        commit_file(&a, "README.md", "one", "initial");
        sh(&a, &["push", "-q", "-u", "origin", "main"]);
        sh(&base, &["clone", "-q", origin.to_str().unwrap(), b.to_str().unwrap()]);
        Sandbox { base, a, b }
    }

    macro_rules! setup {
        () => {{
            if !git_available() {
                eprintln!("git not on PATH: skipping");
                return;
            }
            (lock(&SERIAL), sandbox())
        }};
    }

    #[test]
    fn up_to_date_has_nothing_to_apply() {
        let (_g, sb) = setup!();
        let st = check(&sb.a).unwrap();
        assert_eq!(st.behind, 0);
        assert!(st.commits.is_empty());
        assert!(!st.can_apply);
        assert_eq!(st.branch, "main");
        assert_eq!(st.current.subject, "initial");
        assert_eq!(st.current, st.latest);
        assert!(apply(&sb.a).is_err());
    }

    #[test]
    fn behind_lists_the_new_commits() {
        let (_g, sb) = setup!();
        commit_file(&sb.b, "x.txt", "1", "first change");
        commit_file(&sb.b, "y.txt", "2", "second change");
        sh(&sb.b, &["push", "-q", "origin", "main"]);
        let st = check(&sb.a).unwrap();
        assert_eq!(st.behind, 2);
        assert_eq!(st.commits.len(), 2);
        assert_eq!(st.commits[0].subject, "second change");
        assert_eq!(st.latest.subject, "second change");
        assert_eq!(st.current.subject, "initial");
        assert!(st.dirty.is_empty());
        assert!(st.can_apply, "{:?}", st.blocked_reason);
    }

    #[test]
    fn a_modified_tracked_file_blocks_apply_but_untracked_files_do_not() {
        let (_g, sb) = setup!();
        commit_file(&sb.b, "x.txt", "1", "change");
        sh(&sb.b, &["push", "-q", "origin", "main"]);
        std::fs::write(sb.a.join("new-untracked.txt"), "hi").unwrap();
        assert!(check(&sb.a).unwrap().dirty.is_empty());
        std::fs::write(sb.a.join("README.md"), "edited").unwrap();
        let st = check(&sb.a).unwrap();
        assert_eq!(st.dirty, vec!["README.md".to_string()]);
        assert!(!st.can_apply);
        let err = apply(&sb.a).unwrap_err();
        assert!(err.contains("cambios locales"), "{err}");
        assert_eq!(sh(&sb.a, &["log", "-1", "--format=%s"]), "initial", "nothing was merged");
        assert_eq!(std::fs::read_to_string(sb.a.join("README.md")).unwrap(), "edited");
    }

    #[test]
    fn a_branch_other_than_main_blocks_apply() {
        let (_g, sb) = setup!();
        commit_file(&sb.b, "x.txt", "1", "change");
        sh(&sb.b, &["push", "-q", "origin", "main"]);
        sh(&sb.a, &["checkout", "-q", "-b", "feature"]);
        let st = check(&sb.a).unwrap();
        assert_eq!(st.branch, "feature");
        assert!(!st.can_apply);
        assert!(st.blocked_reason.unwrap().contains("feature"));
        assert!(apply(&sb.a).unwrap_err().contains("feature"));
    }

    #[test]
    fn apply_fast_forwards_and_flags_deps_and_rust() {
        let (_g, sb) = setup!();
        commit_file(&sb.b, "app/package-lock.json", "{}", "bump deps");
        commit_file(&sb.b, "app/src-tauri/src/x.rs", "// x", "rust change");
        commit_file(&sb.b, "app/src/ui.tsx", "//", "ui change");
        sh(&sb.b, &["push", "-q", "origin", "main"]);
        let report = apply(&sb.a).unwrap();
        assert_eq!(report.commits.len(), 3);
        assert!(report.deps_changed);
        assert!(report.rust_changed);
        assert_eq!(report.current.subject, "ui change");
        assert_eq!(sh(&sb.a, &["rev-parse", "HEAD"]), sh(&sb.b, &["rev-parse", "HEAD"]));
    }

    #[test]
    fn frontend_only_update_flags_nothing_and_warmup_lockfile_counts_as_deps() {
        let (_g, sb) = setup!();
        commit_file(&sb.b, "app/src/ui.tsx", "//", "ui change");
        commit_file(&sb.b, "engines/warmup/package.json", "{}", "not a lockfile");
        sh(&sb.b, &["push", "-q", "origin", "main"]);
        let report = apply(&sb.a).unwrap();
        assert!(!report.deps_changed);
        assert!(!report.rust_changed);
        commit_file(&sb.b, "engines/warmup/package-lock.json", "{}", "warmup deps");
        sh(&sb.b, &["push", "-q", "origin", "main"]);
        assert!(apply(&sb.a).unwrap().deps_changed);
    }

    #[test]
    fn a_diverged_copy_fails_with_a_clear_message_and_changes_nothing() {
        let (_g, sb) = setup!();
        commit_file(&sb.a, "local.txt", "mine", "local only");
        commit_file(&sb.b, "x.txt", "1", "remote change");
        sh(&sb.b, &["push", "-q", "origin", "main"]);
        let before = sh(&sb.a, &["rev-parse", "HEAD"]);
        let err = apply(&sb.a).unwrap_err();
        assert!(err.contains("sin mezclar"), "{err}");
        assert_eq!(sh(&sb.a, &["rev-parse", "HEAD"]), before);
    }

    #[test]
    fn a_folder_without_git_gives_a_spanish_error() {
        let (_g, sb) = setup!();
        let plain = sb.base.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(check(&plain).unwrap_err().contains("no está conectada a git"));
        assert!(apply(&plain).unwrap_err().contains("no está conectada a git"));
    }

    #[test]
    fn git_failures_map_to_friendly_messages() {
        let auth = friendly(&GitFail::Exit("fatal: could not read Username for 'https://github.com': terminal prompts disabled".into()), "X");
        assert!(auth.contains("credenciales"));
        let net = friendly(&GitFail::Exit("fatal: unable to access 'https://x': Could not resolve host: github.com".into()), "X");
        assert!(net.contains("conexión"));
        assert!(friendly(&GitFail::Timeout, "X").contains("tiempo de espera"));
        assert!(friendly(&GitFail::Missing, "X").contains("git"));
    }

    #[test]
    fn a_poisoned_lock_counts_as_available() {
        let (_g, sb) = setup!();
        let _ = std::thread::spawn(|| {
            let _held = BUSY.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(BUSY.is_poisoned());
        assert!(check(&sb.a).is_ok());
    }

    #[test]
    fn local_commits_not_on_origin_block_apply() {
        let (_g, sb) = setup!();
        commit_file(&sb.a, "local.txt", "mine", "local only");
        let st = check(&sb.a).unwrap();
        assert_eq!(st.ahead, 1);
        assert!(!st.can_apply);
        assert!(st.blocked_reason.unwrap().contains("cambios propios que no están en GitHub"));
    }

    #[test]
    fn untracked_files_in_the_way_are_listed_in_spanish() {
        let (_g, sb) = setup!();
        commit_file(&sb.b, "u.txt", "theirs", "adds u");
        sh(&sb.b, &["push", "-q", "origin", "main"]);
        std::fs::write(sb.a.join("u.txt"), "mine").unwrap();
        let err = apply(&sb.a).unwrap_err();
        assert!(err.contains("u.txt") && err.contains("Muévelos"), "{err}");
        assert_eq!(std::fs::read_to_string(sb.a.join("u.txt")).unwrap(), "mine");
    }

    #[test]
    fn untracked_overwrite_and_lock_errors_are_mapped() {
        let raw = "error: The following untracked working tree files would be overwritten by merge:\n\ta.txt\n\tdir/b.txt\nPlease move or remove them before you merge.\nAborting";
        assert_eq!(untracked_conflicts(raw), vec!["a.txt".to_string(), "dir/b.txt".to_string()]);
        let msg = friendly_merge(&GitFail::Exit(raw.into()));
        assert!(msg.contains("a.txt") && msg.contains("dir/b.txt"));
        for raw in ["fatal: Unable to create '.git/index.lock': File exists.", "error: unable to unlink old 'x': Permission denied"] {
            assert!(friendly_merge(&GitFail::Exit(raw.into())).contains("actualizar.ps1"), "{raw}");
        }
    }

    #[test]
    fn the_lock_rejects_overlapping_operations() {
        let (_g, sb) = setup!();
        let _held = lock(&BUSY);
        assert!(check(&sb.a).unwrap_err().contains("en curso"));
        assert!(apply(&sb.a).unwrap_err().contains("en curso"));
    }
}
