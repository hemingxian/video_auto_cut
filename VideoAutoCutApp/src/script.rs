use anyhow::{Context, Result, anyhow, bail};
use regex::Regex;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::config::prompt;
use crate::models::{AppPaths, ShotPlan};
use crate::paths::add_child_env;
use crate::process::run_command;

fn is_supported_script_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(OsStr::to_str)
            .map(|s| s.to_lowercase())
            .as_deref(),
        Some(
            "xlsx"
                | "xlsm"
                | "xls"
                | "docx"
                | "doc"
                | "pdf"
                | "txt"
                | "md"
                | "csv"
                | "json"
                | "srt"
        )
    )
}
pub(crate) fn discover_script_file(root: &Path) -> Result<Option<PathBuf>> {
    let mut files = fs::read_dir(root)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    files.retain(|path| {
        path.is_file() && {
            let name = path.file_name().and_then(OsStr::to_str).unwrap_or("");
            !name.starts_with("~$") && is_supported_script_file(path)
        }
    });

    files.sort();

    match files.len() {
        0 => Ok(None),
        1 => Ok(files.into_iter().next()),
        _ => {
            println!("\n检测到多个脚本文档，请选择一个：");
            for (idx, path) in files.iter().enumerate() {
                let name = path.file_name().and_then(OsStr::to_str).unwrap_or("");
                println!("  {}. {}", idx + 1, name);
            }

            loop {
                let answer = prompt("请输入编号")?;
                match answer.trim().parse::<usize>() {
                    Ok(n) if n >= 1 && n <= files.len() => return Ok(Some(files[n - 1].clone())),
                    _ => println!("编号无效，请输入 1-{}", files.len()),
                }
            }
        }
    }
}

pub(crate) fn read_plan_from_file(path: &Path) -> Result<ShotPlan> {
    let text = fs::read_to_string(path)
        .with_context(|| format!("读取分镜 JSON 失败: {}", path.display()))?;
    parse_plan_json(&text, "")
}

pub(crate) fn read_plan_from_script_ai(
    paths: &AppPaths,
    path: &Path,
    default_topic: &str,
    voice_script_body: Option<&Path>,
) -> Result<ShotPlan> {
    let script = paths.root.join("tools").join("normalize_script.py");
    if !script.exists() {
        bail!("未找到 tools/normalize_script.py");
    }

    let (python, _) = paths
        .sentry_py
        .as_ref()
        .ok_or_else(|| anyhow!("找不到用于脚本文档解析的内置 Python"))?;

    let out_path = paths
        .data_root
        .join("temp")
        .join("normalized_script_shots.json");
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut cmd = Command::new(python);
    add_child_env(&mut cmd, paths);
    add_normalize_script_args(
        &mut cmd,
        &script,
        path,
        &out_path,
        default_topic,
        voice_script_body,
    );

    run_command(&mut cmd, "python normalize_script")?;
    read_plan_from_file(&out_path)
}

fn parse_plan_json(content: &str, default_topic: &str) -> Result<ShotPlan> {
    let cleaned = strip_code_fence(content);
    let mut plan: ShotPlan = serde_json::from_str(&cleaned)
        .with_context(|| format!("AI 返回的分镜 JSON 无法读取: {}", json_preview(&cleaned)))?;

    if plan.topic.trim().is_empty() {
        plan.topic = default_topic.to_string();
    }

    for (i, shot) in plan.shots.iter_mut().enumerate() {
        if shot.shot == 0 {
            shot.shot = i + 1;
        }
    }

    if plan.shots.is_empty() {
        bail!("分镜计划为空");
    }

    Ok(plan)
}

fn json_preview(content: &str) -> String {
    const MAX_CHARS: usize = 1200;
    let mut preview: String = content.chars().take(MAX_CHARS).collect();
    if content.chars().count() > MAX_CHARS {
        preview.push_str("...");
    }
    preview
}

fn strip_code_fence(s: &str) -> String {
    let s = s.trim();
    if !s.starts_with("```") {
        return s.to_string();
    }

    let re = Regex::new(r"(?s)^```(?:json)?\s*(.*?)\s*```$").unwrap();
    re.captures(s)
        .and_then(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
        .unwrap_or_else(|| s.to_string())
}

fn add_normalize_script_args(
    cmd: &mut Command,
    script: &Path,
    input: &Path,
    output: &Path,
    topic: &str,
    voice_script_body: Option<&Path>,
) {
    cmd.arg(script)
        .arg("--input")
        .arg(input)
        .arg("--output")
        .arg(output)
        .arg("--topic")
        .arg(topic);
    if let Some(body_path) = voice_script_body {
        cmd.arg("--voice-script-body").arg(body_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::write_json_pretty_atomic;
    use serde_json::{Value, json};
    use std::ffi::OsStr;

    #[test]
    fn read_then_atomic_write_preserves_unknown_metadata() {
        let root = std::env::temp_dir().join(format!("vac-schema-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let input_path = root.join("input.json");
        let output_path = root.join("output.json");
        let input = json!({"schema_version":2,"task_revision":0,"topic":"t",
            "script_source":{"template":"VAC-SB-1"},"shots":[{
            "shot_id":"s1","shot":1,"title":"one","download_query":"","visual_query":"",
            "duration":null,"script_meta":{"review":{"warnings":["w"]}}
        }]});
        fs::write(&input_path, serde_json::to_vec(&input).unwrap()).unwrap();
        let plan = read_plan_from_file(&input_path).unwrap();
        write_json_pretty_atomic(&output_path, &plan).unwrap();
        let output: Value = serde_json::from_slice(&fs::read(&output_path).unwrap()).unwrap();
        assert_eq!(output, input);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn normalize_script_args_forward_optional_voice_body_verbatim() {
        let script = Path::new("normalize_script.py");
        let input = Path::new(r"C:\脚本 目录\输入.txt");
        let output = Path::new(r"C:\输出 目录\shots.json");
        let body = Path::new(r"C:\正文 目录\口播正文.txt");
        let mut with_body = Command::new("python");
        add_normalize_script_args(
            &mut with_body,
            script,
            input,
            output,
            "食品码垛",
            Some(body),
        );
        let args: Vec<_> = with_body.get_args().collect();
        assert!(
            args.windows(2)
                .any(|pair| { pair == [OsStr::new("--voice-script-body"), body.as_os_str()] })
        );

        let mut without_body = Command::new("python");
        add_normalize_script_args(&mut without_body, script, input, output, "食品码垛", None);
        assert_eq!(
            without_body.get_args().collect::<Vec<_>>(),
            [
                script.as_os_str(),
                OsStr::new("--input"),
                input.as_os_str(),
                OsStr::new("--output"),
                output.as_os_str(),
                OsStr::new("--topic"),
                OsStr::new("食品码垛"),
            ]
        );
    }
}
