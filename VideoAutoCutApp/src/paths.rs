use anyhow::{Context, Result, bail};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::models::AppPaths;
use crate::remote_config;

impl AppPaths {
    pub(crate) fn discover() -> Result<Self> {
        let exe = env::current_exe().context("无法获取当前 exe 路径")?;
        let exe_dir = exe.parent().unwrap_or(Path::new(".")).to_path_buf();
        let cwd = env::current_dir()?;

        let parent_with_runtime = cwd.parent().filter(|parent| {
            parent.join("yt-dlp.exe").exists() || parent.join("sentrysearch").exists()
        });

        let root = if exe_dir.join("yt-dlp.exe").exists() || exe_dir.join("sentrysearch").exists() {
            exe_dir
        } else if cwd.join("yt-dlp.exe").exists() || cwd.join("sentrysearch").exists() {
            cwd
        } else if let Some(parent) = parent_with_runtime {
            parent.to_path_buf()
        } else {
            cwd
        };

        let data_root = env::var_os("VIDEOAUTO_DATA_ROOT")
            .or_else(|| env::var_os("VIDEOAUTO_WORKSPACE_DIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| root.clone());
        fs::create_dir_all(&data_root)?;

        let env_path = configured_env_path(&data_root);
        if env_path.exists() {
            dotenvy::from_path(&env_path)
                .with_context(|| format!("加载运行配置失败: {}", env_path.display()))?;
        }

        let yt_dlp = root.join("yt-dlp.exe");
        if !yt_dlp.exists() {
            bail!("找不到 yt-dlp.exe: {}", yt_dlp.display());
        }

        let sentrysearch = root.join("sentrysearch").join("sentrysearch.exe");
        let sentry_py = find_sentry_py(&root);
        if sentry_py.is_none() && !sentrysearch.exists() {
            bail!(
                "找不到 sentrysearch。需要 sentrysearch/sentrysearch_entry.py + 内置 Python，或 sentrysearch/sentrysearch.exe"
            );
        }

        let ffmpeg = find_exe(&root, "ffmpeg.exe");
        let node = find_exe(&root, "node.exe");
        let runs_dir = data_root.join("video").join("runs");
        fs::create_dir_all(&runs_dir)?;

        Ok(Self {
            root: root.clone(),
            data_root: data_root.clone(),
            env_path: env_path.clone(),
            yt_dlp,
            sentrysearch,
            sentry_py,
            ffmpeg,
            node,
            runs_dir,
            archive: data_root.join("downloaded.txt"),
        })
    }
}

fn configured_env_path(data_root: &Path) -> PathBuf {
    if let Some(path) = configured_optional_path("VIDEOAUTO_ENV_PATH", data_root) {
        return path;
    }
    if let Some(root) = configured_optional_path("VIDEOAUTO_CONFIG_ROOT", data_root) {
        return root.join("app.env");
    }
    data_root.join(".env")
}

fn configured_optional_path(key: &str, base: &Path) -> Option<PathBuf> {
    let value = env::var(key).ok()?;
    let value = value.trim().trim_matches(|c| c == '"' || c == '\'').trim();
    if value.is_empty() {
        return None;
    }

    let path = PathBuf::from(value);
    Some(if path.is_absolute() {
        path
    } else {
        base.join(path)
    })
}

pub(crate) fn find_exe(root: &Path, name: &str) -> Option<PathBuf> {
    let candidates = [
        root.join(name),
        root.join("bin").join(name),
        root.join("ffmpeg").join("bin").join(name),
    ];

    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }

    let path_var = env::var_os("PATH")?;
    for p in env::split_paths(&path_var) {
        let candidate = p.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

fn find_sentry_py(root: &Path) -> Option<(PathBuf, PathBuf)> {
    let entry_candidates = [
        root.join("sentrysearch").join("sentrysearch_entry.py"),
        root.join("sentrysearch_py").join("sentrysearch_entry.py"),
        root.join("sentrysearch_src").join("sentrysearch_entry.py"),
        root.join("sentrysearch_python")
            .join("sentrysearch_entry.py"),
    ];
    let python_candidates = [
        root.join("python-3.11.9-embed-amd64").join("python.exe"),
        root.join("python-3.11.9").join("python.exe"),
        root.join("python").join("python.exe"),
        root.join("sentrysearch")
            .join(".venv")
            .join("Scripts")
            .join("python.exe"),
        root.join("sentrysearch_py")
            .join(".venv")
            .join("Scripts")
            .join("python.exe"),
    ];

    for entry in entry_candidates {
        if !entry.exists() {
            continue;
        }
        for py in &python_candidates {
            if py.exists() {
                return Some((py.clone(), entry.clone()));
            }
        }
    }

    None
}

fn ffmpeg_bin_dir(paths: &AppPaths) -> Option<PathBuf> {
    paths
        .ffmpeg
        .as_ref()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

pub(crate) fn add_child_env(cmd: &mut Command, paths: &AppPaths) {
    cmd.current_dir(&paths.data_root);
    cmd.env("VIDEOAUTO_ROOT", &paths.root);
    cmd.env("VIDEOAUTO_RUNTIME_ROOT", &paths.root);
    cmd.env("VIDEOAUTO_DATA_ROOT", &paths.data_root);

    if let Some(config_root) = paths.env_path.parent() {
        cmd.env("VIDEOAUTO_CONFIG_ROOT", config_root);
    }

    cmd.env("VIDEOAUTO_ENV_PATH", &paths.env_path);
    cmd.env("VIDEOAUTO_TEMP_DIR", paths.data_root.join("temp"));
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUNBUFFERED", "1");

    if remote_config::is_required() {
        for key in [
            "DASHSCOPE_API_KEY",
            "PEXELS_API_KEY",
            "PIXABAY_API_KEY",
            "JAMENDO_CLIENT_ID",
            "OPENVERSE_CLIENT_ID",
            "OPENVERSE_CLIENT_SECRET",
        ] {
            if !remote_config::has_key(key) {
                cmd.env_remove(key);
            }
        }
    }

    if let Some(bin) = ffmpeg_bin_dir(paths) {
        let old_path = env::var_os("PATH").unwrap_or_default();
        let mut parts = vec![bin];
        parts.extend(env::split_paths(&old_path));

        if let Ok(joined) = env::join_paths(parts) {
            cmd.env("PATH", joined);
        }
    }
}
