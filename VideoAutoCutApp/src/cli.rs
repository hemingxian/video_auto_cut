use clap::{ArgAction, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

#[derive(Clone, Debug, ValueEnum)]
pub(crate) enum Source {
    Pexels,
    Pixabay,
    WikimediaCommons,
}

impl Source {
    pub(crate) fn provider_key(&self) -> &'static str {
        match self {
            Source::Pexels => "pexels",
            Source::Pixabay => "pixabay",
            Source::WikimediaCommons => "wikimedia-commons",
        }
    }

    pub(crate) fn yt_dlp_search_prefix(&self) -> Option<&'static str> {
        match self {
            Source::Pexels | Source::Pixabay | Source::WikimediaCommons => None,
        }
    }

    pub(crate) fn label(&self) -> &'static str {
        match self {
            Source::Pexels => "Pexels",
            Source::Pixabay => "Pixabay",
            Source::WikimediaCommons => "Wikimedia Commons",
        }
    }
}

#[derive(Parser, Debug)]
#[command(name = "VideoAuto")]
#[command(version)]
#[command(about = "AI 分镜视频自动化：脚本文档 -> 分镜 -> 下载 -> 搜索素材 -> 合成")]
pub(crate) struct Cli {
    #[arg(short, long)]
    pub(crate) topic: Option<String>,

    /// 素材库中的稳定项目显示名称。继续使用分镜 JSON 时由桌面端传回。
    #[arg(long)]
    pub(crate) project_name: Option<String>,

    #[arg(long, default_value_t = 6)]
    pub(crate) shots: usize,

    #[arg(long, value_enum)]
    pub(crate) source: Option<Source>,

    #[arg(long)]
    pub(crate) downloads_per_shot: Option<usize>,

    #[arg(long)]
    pub(crate) clips_per_shot: Option<usize>,

    #[arg(long)]
    pub(crate) results_per_shot: Option<usize>,

    #[arg(long)]
    pub(crate) chunk_duration: Option<u32>,

    #[arg(long)]
    pub(crate) shots_json: Option<PathBuf>,

    /// Output aspect ratio; unused canvas is filled with black.
    #[arg(long, value_parser = ["4:3", "3:4", "9:16", "16:9"])]
    pub(crate) aspect_ratio: Option<String>,

    /// Output resolution: 720p for 16:9, or 4k for 16:9 / 9:16.
    #[arg(long, value_parser = ["720p", "1080p", "4k"])]
    pub(crate) output_resolution: Option<String>,

    #[arg(long)]
    pub(crate) material_manifest: Option<PathBuf>,

    /// 从脚本文档读取分镜，支持 xlsx/xlsm/xls/docx/doc/pdf/txt/md/csv/json/srt。
    #[arg(long)]
    pub(crate) script_file: Option<PathBuf>,

    /// 非标准脚本的口播正文文件；正文逐字传给 normalize_script.py。
    #[arg(long)]
    pub(crate) voice_script_body: Option<PathBuf>,

    /// 使用外部已经编排好的 capability steps 任务计划。
    #[arg(long)]
    pub(crate) job_plan_json: Option<PathBuf>,

    /// Continue a run using verified completed-step checkpoints.
    #[arg(long, conflicts_with = "restart_all")]
    pub(crate) resume_run: Option<PathBuf>,

    /// Create a fresh run without reusing generated artifacts.
    #[arg(long)]
    pub(crate) restart_all: bool,

    #[arg(long)]
    pub(crate) plan_only: bool,

    #[arg(long)]
    pub(crate) skip_download: bool,

    #[arg(long)]
    pub(crate) skip_index: bool,

    #[arg(long)]
    pub(crate) skip_concat: bool,

    #[arg(long = "no-voiceover", action = ArgAction::SetFalse, default_value_t = true)]
    pub(crate) voiceover: bool,

    #[arg(long = "no-subtitles", action = ArgAction::SetFalse, default_value_t = true)]
    pub(crate) subtitles: bool,

    #[arg(long = "no-progress-bar", action = ArgAction::SetFalse, default_value_t = true)]
    pub(crate) progress_bar: bool,

    #[command(subcommand)]
    pub(crate) command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
pub(crate) enum Commands {
    CleanMissing,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn parses_voice_script_body_path_with_spaces_and_chinese() {
        let path = r"C:\稿件 目录\口播正文.txt";
        let cli = Cli::try_parse_from([
            "VideoAuto",
            "--script-file",
            "input.txt",
            "--voice-script-body",
            path,
        ])
        .unwrap();
        assert_eq!(cli.voice_script_body.as_deref(), Some(Path::new(path)));
    }
}
