use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::{fs, path::Path};

#[derive(Debug, PartialEq, Eq, Serialize)]
pub(crate) struct OutputFormat {
    pub(crate) aspect_ratio: String,
    pub(crate) resolution: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    fill: &'static str,
}

pub(crate) fn dimensions(ratio: &str, resolution: &str) -> Result<(u32, u32)> {
    match (ratio, resolution) {
        ("4:3", "1080p") => Ok((1440, 1080)),
        ("3:4", "1080p") => Ok((1080, 1440)),
        ("9:16", "1080p") => Ok((1080, 1920)),
        ("16:9", "1080p") => Ok((1920, 1080)),
        ("16:9", "720p") => Ok((1280, 720)),
        ("16:9", "4k") => Ok((3840, 2160)),
        ("9:16", "4k") => Ok((2160, 3840)),
        _ => bail!("不支持的成片比例与分辨率：{ratio} / {resolution}"),
    }
}

fn read_saved(file: &Path) -> Result<OutputFormat> {
    let value: serde_json::Value = serde_json::from_str(&fs::read_to_string(file)?)?;
    let ratio = value["aspect_ratio"].as_str().context("任务尺寸记录无效")?;
    let resolution = value
        .get("resolution")
        .map(|item| item.as_str().context("任务分辨率记录无效"))
        .transpose()?
        .unwrap_or("1080p");
    let (width, height) = dimensions(ratio, resolution)?;
    if value
        .get("width")
        .is_some_and(|item| item.as_u64() != Some(u64::from(width)))
        || value
            .get("height")
            .is_some_and(|item| item.as_u64() != Some(u64::from(height)))
    {
        bail!("任务尺寸记录与分辨率不一致，请重新生成全部");
    }
    Ok(OutputFormat {
        aspect_ratio: ratio.into(),
        resolution: resolution.into(),
        width,
        height,
        fill: "black",
    })
}

pub(crate) fn configure(
    requested: Option<&str>,
    resolution: Option<&str>,
    shots: Option<&Path>,
    run: &Path,
    resume: bool,
) -> Result<OutputFormat> {
    let previous = if resume {
        Some(run.join("output-format.json"))
    } else {
        shots
            .and_then(Path::parent)
            .map(|p| p.join("output-format.json"))
    };
    let saved = previous
        .filter(|p| p.exists())
        .map(|p| read_saved(&p))
        .transpose()?;
    let saved_ratio = saved
        .as_ref()
        .map(|item| item.aspect_ratio.as_str())
        .unwrap_or("16:9");
    let saved_resolution = saved
        .as_ref()
        .map(|item| item.resolution.as_str())
        .unwrap_or("1080p");
    let ratio = requested.unwrap_or(saved_ratio);
    let resolution = resolution.unwrap_or(saved_resolution);
    if resume && (ratio != saved_ratio || resolution != saved_resolution) {
        bail!("断点续跑不能改变成片比例或分辨率，请重新生成全部");
    }
    let (width, height) = dimensions(ratio, resolution)?;
    let format = OutputFormat {
        aspect_ratio: ratio.into(),
        resolution: resolution.into(),
        width,
        height,
        fill: "black",
    };
    crate::persistence::write_json_pretty_atomic(&run.join("output-format.json"), &format)?;
    println!(
        "成片比例: {ratio}，分辨率: {resolution}，输出尺寸: {width}x{height}，等比例居中、纯黑填充"
    );
    Ok(format)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn task_canvas_survives_continue_and_resume() {
        let root = std::env::temp_dir().join(format!("canvas-test-{}", std::process::id()));
        let first = root.join("first");
        let next = root.join("next");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&next).unwrap();
        configure(Some("9:16"), Some("4k"), None, &first, false).unwrap();
        let continued =
            configure(None, None, Some(&first.join("shots.json")), &next, false).unwrap();
        assert_eq!((continued.width, continued.height), (2160, 3840));
        assert_eq!(configure(None, None, None, &next, true).unwrap(), continued);
        assert!(configure(Some("4:3"), None, None, &next, true).is_err());
        assert!(configure(None, Some("1080p"), None, &next, true).is_err());
        assert_eq!(
            configure(
                Some("16:9"),
                Some("720p"),
                Some(&first.join("shots.json")),
                &next,
                false
            )
            .unwrap()
            .width,
            1280
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn requested_sizes_are_exact_and_other_combinations_are_rejected() {
        for (ratio, resolution, size) in [
            ("16:9", "720p", (1280, 720)),
            ("16:9", "1080p", (1920, 1080)),
            ("16:9", "4k", (3840, 2160)),
            ("9:16", "4k", (2160, 3840)),
            ("9:16", "1080p", (1080, 1920)),
            ("4:3", "1080p", (1440, 1080)),
            ("3:4", "1080p", (1080, 1440)),
        ] {
            assert_eq!(dimensions(ratio, resolution).unwrap(), size);
        }
        for (ratio, resolution) in [
            ("4:3", "4k"),
            ("3:4", "720p"),
            ("9:16", "720p"),
            ("1:1", "1080p"),
            ("16:9", "8k"),
        ] {
            assert!(dimensions(ratio, resolution).is_err());
        }
    }

    #[test]
    fn legacy_records_keep_their_canvas_and_invalid_dimensions_fail_closed() {
        let root = std::env::temp_dir().join(format!("canvas-legacy-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("output-format.json"),
            r#"{"aspect_ratio":"9:16","width":1080,"height":1920}"#,
        )
        .unwrap();
        let saved = configure(None, None, None, &root, true).unwrap();
        assert_eq!(saved.resolution, "1080p");
        assert_eq!((saved.width, saved.height), (1080, 1920));
        fs::write(
            root.join("output-format.json"),
            r#"{"aspect_ratio":"16:9","resolution":"4k","width":3840,"height":210}"#,
        )
        .unwrap();
        assert!(configure(None, None, None, &root, true).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
