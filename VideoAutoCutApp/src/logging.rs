use anyhow::{Context, Result};
use chrono::Local;
use std::env;
use std::fs::{self, File, OpenOptions};
#[cfg(not(windows))]
use std::io;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

static LOG_FILES: OnceLock<Mutex<Vec<File>>> = OnceLock::new();

pub(crate) fn init_run_log(root: &Path, run_dir: &Path) -> Result<()> {
    let root_log = root.join("VideoAuto_last_run.log");
    let run_log = run_dir.join("run.log");
    let files = vec![
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&root_log)
            .with_context(|| format!("无法创建日志文件: {}", root_log.display()))?,
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&run_log)
            .with_context(|| format!("无法创建日志文件: {}", run_log.display()))?,
    ];

    let _ = LOG_FILES.set(Mutex::new(files));
    log_line(format!("日志已启动: {}", run_log.display()));
    Ok(())
}

pub(crate) fn log_line(message: impl AsRef<str>) {
    let Some(files) = LOG_FILES.get() else {
        return;
    };

    let ts = Local::now().format("%Y-%m-%d %H:%M:%S");
    let line = format!("[{}] {}\n\n", ts, message.as_ref());

    if let Ok(mut files) = files.lock() {
        for f in files.iter_mut() {
            let _ = f.write_all(line.as_bytes());
            let _ = f.flush();
        }
    }
}

pub(crate) fn log_text(prefix: &str, text: &str) {
    for line in text.lines() {
        log_line(format!("{}: {}", prefix, line));
    }
}

pub(crate) fn clear_last_error_file(root: &Path) {
    let _ = fs::remove_file(root.join("VideoAuto_last_error.txt"));
}

pub(crate) fn write_last_error(message: &str) -> Result<()> {
    let exe = env::current_exe().context("无法获取当前 exe 路径")?;
    let dir = env::var_os("VIDEOAUTO_DATA_ROOT")
        .or_else(|| env::var_os("VIDEOAUTO_WORKSPACE_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| exe.parent().unwrap_or(Path::new(".")).to_path_buf());

    fs::create_dir_all(&dir)?;
    let path = dir.join("VideoAuto_last_error.txt");
    fs::write(&path, message)?;
    log_line(format!("错误日志已写入: {}", path.display()));
    Ok(())
}

pub(crate) fn pause_before_exit() {
    let no_pause = env::var("VIDEOAUTO_NO_PAUSE")
        .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "true"))
        .unwrap_or(false);
    if no_pause {
        return;
    }

    println!("\n按回车键退出...");

    #[cfg(windows)]
    {
        let _ = Command::new("cmd").arg("/C").arg("pause").status();
    }

    #[cfg(not(windows))]
    {
        let mut s = String::new();
        let _ = io::stdin().read_line(&mut s);
    }
}
