use std::collections::HashSet;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use anyhow::Result;

use crate::models::SkillInfo;

const PROJECT_SKILLS_DIR: &str = ".agents/skills";
const GLOBAL_SKILLS_DIR: &str = "~/.agents/skills";
const MAX_SKILL_METADATA_BYTES: usize = 256 * 1024;

pub fn list_skills(workspace_path: &str) -> Result<Vec<SkillInfo>> {
    let mut discovered = Vec::new();
    let mut seen_ids = HashSet::new();

    for root in skill_roots(workspace_path) {
        if !root.path.exists() {
            continue;
        }

        let root_entries = match fs::read_dir(&root.path) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in root_entries {
            let Ok(entry) = entry else {
                continue;
            };
            let path = entry.path();
            // Path::is_dir follows symlinks, which Codex supports for skill folders.
            if !path.is_dir() {
                continue;
            }

            let skill_md = path.join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }

            let Some(id) = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(ToOwned::to_owned)
            else {
                continue;
            };
            if !is_valid_skill_id(&id) || seen_ids.contains(&id) {
                continue;
            }

            let bounded = match read_text_bounded(&skill_md, MAX_SKILL_METADATA_BYTES) {
                Ok(raw) => raw,
                Err(_) => continue,
            };

            let mut parsed = parse_skill_markdown(&bounded.text, &id);
            if bounded.truncated {
                append_warning(
                    &mut parsed.warning,
                    "SKILL.md is larger than 256 KiB; ATController read only its metadata preview.",
                );
            }
            if bounded.had_invalid_utf8 {
                append_warning(
                    &mut parsed.warning,
                    "SKILL.md contains invalid UTF-8; ATController displayed a best-effort preview.",
                );
            }
            discovered.push(SkillInfo {
                id: id.clone(),
                name: parsed.name,
                description: parsed.description,
                entry_points: parsed.entry_points,
                path: path.to_string_lossy().to_string(),
                relative_path: format!("{}/{id}/SKILL.md", root.relative_root),
                is_global: root.is_global,
                warning: parsed.warning,
            });
            seen_ids.insert(id);
        }
    }

    discovered.sort_by_key(|item| item.name.to_lowercase());
    Ok(discovered)
}

#[derive(Debug)]
struct ParsedSkillMarkdown {
    name: String,
    description: String,
    entry_points: Vec<String>,
    warning: Option<String>,
}

#[derive(Debug, Clone)]
struct SkillRoot {
    path: PathBuf,
    relative_root: String,
    is_global: bool,
}

fn skill_roots(workspace_path: &str) -> Vec<SkillRoot> {
    let workspace = Path::new(workspace_path);
    let mut roots = Vec::new();
    let repository_root = workspace
        .ancestors()
        .find(|directory| directory.join(".git").exists());

    for (depth, directory) in workspace.ancestors().enumerate() {
        let relative_root = if depth == 0 {
            PROJECT_SKILLS_DIR.to_string()
        } else {
            format!("{}{PROJECT_SKILLS_DIR}", "../".repeat(depth))
        };
        roots.push(SkillRoot {
            path: directory.join(PROJECT_SKILLS_DIR),
            relative_root,
            is_global: false,
        });
        if repository_root.is_none() || repository_root == Some(directory) {
            break;
        }
    }

    if let Some(path) = expand_home_path(GLOBAL_SKILLS_DIR) {
        roots.push(SkillRoot {
            path,
            relative_root: GLOBAL_SKILLS_DIR.to_string(),
            is_global: true,
        });
    }

    roots
}

fn is_valid_skill_id(skill_id: &str) -> bool {
    if skill_id.is_empty() || skill_id.trim() != skill_id {
        return false;
    }

    let mut components = Path::new(skill_id).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

struct BoundedText {
    text: String,
    truncated: bool,
    had_invalid_utf8: bool,
}

fn read_text_bounded(path: &Path, max_bytes: usize) -> io::Result<BoundedText> {
    let file = fs::File::open(path)?;
    let mut bytes = Vec::with_capacity(max_bytes.min(16 * 1024));
    file.take(max_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)?;

    let truncated = bytes.len() > max_bytes;
    if truncated {
        bytes.truncate(max_bytes);
    }

    match String::from_utf8(bytes) {
        Ok(text) => Ok(BoundedText {
            text,
            truncated,
            had_invalid_utf8: false,
        }),
        Err(error) => Ok(BoundedText {
            text: String::from_utf8_lossy(error.as_bytes()).into_owned(),
            truncated,
            had_invalid_utf8: true,
        }),
    }
}

fn expand_home_path(path: &str) -> Option<PathBuf> {
    let Some(stripped) = path.strip_prefix("~/") else {
        return Some(PathBuf::from(path));
    };

    resolve_home_dir().map(|home| home.join(stripped))
}

fn resolve_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
}

fn parse_skill_markdown(raw: &str, fallback_id: &str) -> ParsedSkillMarkdown {
    let lines: Vec<&str> = raw.lines().collect();
    let mut front_matter = parse_front_matter(&lines);
    validate_front_matter(&mut front_matter, fallback_id);
    let body = &lines[front_matter.body_start.min(lines.len())..];
    let legacy_name = find_legacy_heading(body);
    let legacy_description = find_legacy_description(body);
    let entry_points = find_entry_points(body);

    let name = front_matter
        .name
        .or(legacy_name)
        .unwrap_or_else(|| fallback_id.to_string());
    let description = front_matter
        .description
        .or(legacy_description)
        .unwrap_or_default();

    ParsedSkillMarkdown {
        name,
        description,
        entry_points,
        warning: front_matter.warning,
    }
}

struct FrontMatter {
    name: Option<String>,
    description: Option<String>,
    body_start: usize,
    warning: Option<String>,
}

fn parse_front_matter(lines: &[&str]) -> FrontMatter {
    let starts_with_delimiter = lines
        .first()
        .map(|line| line.trim_start_matches('\u{feff}').trim_end().eq("---"))
        .unwrap_or(false);
    if !starts_with_delimiter {
        return FrontMatter {
            name: None,
            description: None,
            body_start: 0,
            warning: Some(
                "SKILL.md is missing YAML front matter with required name and description fields; displaying fallback metadata."
                    .to_string(),
            ),
        };
    }

    let Some(end) = lines
        .iter()
        .enumerate()
        .skip(1)
        .find_map(|(index, line)| (line.trim_end() == "---").then_some(index))
    else {
        return FrontMatter {
            name: None,
            description: None,
            body_start: 0,
            warning: Some(
                "SKILL.md has unclosed YAML front matter; displaying fallback metadata."
                    .to_string(),
            ),
        };
    };

    let mut name = None;
    let mut description = None;
    let mut index = 1;
    while index < end {
        let line = lines[index];
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || has_yaml_indentation(line) {
            index += 1;
            continue;
        }

        let Some((key, raw_value)) = line.split_once(':') else {
            index += 1;
            continue;
        };
        let key = key.trim();
        if key != "name" && key != "description" {
            index += 1;
            continue;
        }

        let value_without_comment = strip_yaml_comment(raw_value).trim();
        let (value, next_index) = if is_block_scalar_header(value_without_comment) {
            parse_block_scalar(
                lines,
                index + 1,
                end,
                value_without_comment.starts_with('>'),
            )
        } else {
            (parse_yaml_scalar(raw_value), index + 1)
        };

        if key == "name" {
            if name.is_none() {
                name = value;
            }
        } else if description.is_none() {
            description = value;
        }
        index = next_index;
    }

    let missing_fields = match (name.is_some(), description.is_some()) {
        (false, false) => Some("name and description"),
        (false, true) => Some("name"),
        (true, false) => Some("description"),
        (true, true) => None,
    };
    let warning = missing_fields.map(|fields| {
        format!(
            "SKILL.md YAML front matter is missing a non-empty {fields} field; displaying fallback metadata where available."
        )
    });

    FrontMatter {
        name,
        description,
        body_start: end + 1,
        warning,
    }
}

fn validate_front_matter(front_matter: &mut FrontMatter, fallback_id: &str) {
    if let Some(name) = front_matter.name.as_deref() {
        if !is_standard_skill_name(name) {
            front_matter.name = None;
            append_warning(
                &mut front_matter.warning,
                "SKILL.md name must contain 1–64 lowercase letters, numbers, or hyphens, without leading, trailing, or consecutive hyphens.",
            );
        } else if name != fallback_id {
            front_matter.name = None;
            append_warning(
                &mut front_matter.warning,
                "SKILL.md name must match its parent folder name.",
            );
        }
    }

    if front_matter
        .description
        .as_ref()
        .is_some_and(|description| description.chars().count() > 1024)
    {
        front_matter.description = None;
        append_warning(
            &mut front_matter.warning,
            "SKILL.md description must not exceed 1,024 characters.",
        );
    }
}

fn is_standard_skill_name(name: &str) -> bool {
    let length = name.chars().count();
    (1..=64).contains(&length)
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
        && name.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

fn has_yaml_indentation(line: &str) -> bool {
    line.starts_with(' ') || line.starts_with('\t')
}

fn is_block_scalar_header(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some('|') | Some('>'))
        && chars.all(|character| character.is_ascii_digit() || character == '+' || character == '-')
}

fn parse_block_scalar(
    lines: &[&str],
    start: usize,
    end: usize,
    fold_lines: bool,
) -> (Option<String>, usize) {
    let mut index = start;
    let mut block_lines = Vec::new();
    while index < end {
        let line = lines[index];
        if !line.trim().is_empty() && !has_yaml_indentation(line) {
            break;
        }
        block_lines.push(line);
        index += 1;
    }

    let minimum_indent = block_lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start_matches([' ', '\t']).len())
        .min()
        .unwrap_or(0);
    let normalized: Vec<String> = block_lines
        .iter()
        .map(|line| {
            if line.trim().is_empty() {
                String::new()
            } else {
                line.get(minimum_indent..)
                    .unwrap_or(line)
                    .trim_end()
                    .to_string()
            }
        })
        .collect();

    let text = if fold_lines {
        fold_yaml_lines(&normalized)
    } else {
        normalized.join("\n")
    };
    (non_empty(text), index)
}

fn fold_yaml_lines(lines: &[String]) -> String {
    let mut folded = String::new();
    let mut previous_was_blank = false;
    for line in lines {
        if line.is_empty() {
            if !folded.is_empty() && !folded.ends_with('\n') {
                folded.push('\n');
            }
            previous_was_blank = true;
            continue;
        }
        if !folded.is_empty() && !folded.ends_with('\n') && !previous_was_blank {
            folded.push(' ');
        }
        folded.push_str(line);
        previous_was_blank = false;
    }
    folded
}

fn parse_yaml_scalar(raw_value: &str) -> Option<String> {
    let value = strip_yaml_comment(raw_value).trim();
    if value.is_empty() || matches!(value, "null" | "Null" | "NULL" | "~") {
        return None;
    }

    if value.starts_with('"') {
        return serde_json::from_str::<String>(value)
            .ok()
            .and_then(non_empty);
    }
    if let Some(inner) = value
        .strip_prefix('\'')
        .and_then(|value| value.strip_suffix('\''))
    {
        return non_empty(inner.replace("''", "'"));
    }
    if value.starts_with('[') || value.starts_with('{') {
        return None;
    }

    non_empty(value.to_string())
}

fn strip_yaml_comment(value: &str) -> &str {
    let mut in_single_quotes = false;
    let mut in_double_quotes = false;
    let mut escaped = false;
    let mut previous = None;

    for (index, character) in value.char_indices() {
        if escaped {
            escaped = false;
            previous = Some(character);
            continue;
        }
        if in_double_quotes && character == '\\' {
            escaped = true;
            previous = Some(character);
            continue;
        }
        match character {
            '\'' if !in_double_quotes => in_single_quotes = !in_single_quotes,
            '"' if !in_single_quotes => in_double_quotes = !in_double_quotes,
            '#' if !in_single_quotes
                && !in_double_quotes
                && (index == 0 || previous.is_some_and(char::is_whitespace)) =>
            {
                return &value[..index];
            }
            _ => {}
        }
        previous = Some(character);
    }

    value
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn find_legacy_heading(lines: &[&str]) -> Option<String> {
    lines.iter().find_map(|line| {
        let trimmed = line.trim();
        trimmed
            .strip_prefix("# ")
            .and_then(|heading| non_empty(heading.to_string()))
    })
}

fn find_legacy_description(lines: &[&str]) -> Option<String> {
    let heading_index = lines.iter().position(|line| line.trim().starts_with("# "));
    let start = heading_index.map_or(0, |index| index + 1);
    let mut description_lines = Vec::new();

    for line in lines.iter().skip(start) {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.starts_with("```") {
            if !description_lines.is_empty() {
                break;
            }
            continue;
        }
        if trimmed.is_empty() {
            if !description_lines.is_empty() {
                break;
            }
            continue;
        }
        description_lines.push(trimmed.to_string());
    }

    non_empty(description_lines.join(" "))
}

fn find_entry_points(lines: &[&str]) -> Vec<String> {
    let mut entry_points = Vec::new();
    if let Some((start_idx, _)) = lines.iter().enumerate().find(|(_, line)| {
        line.trim_start()
            .to_lowercase()
            .starts_with("## entry points")
    }) {
        for line in lines.iter().skip(start_idx + 1) {
            let trimmed = line.trim();
            if trimmed.starts_with("## ") {
                break;
            }
            if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
                entry_points.push(trimmed[2..].trim().to_string());
            }
        }
    }
    entry_points
}

fn append_warning(warning: &mut Option<String>, message: &str) {
    match warning {
        Some(existing) => {
            existing.push(' ');
            existing.push_str(message);
        }
        None => *warning = Some(message.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::fs;
    use std::sync::{Mutex, OnceLock};

    fn home_env_lock() -> &'static Mutex<()> {
        static HOME_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        HOME_ENV_LOCK.get_or_init(|| Mutex::new(()))
    }

    struct HomeEnvGuard {
        previous_home: Option<OsString>,
    }

    impl HomeEnvGuard {
        fn set(path: &Path) -> Self {
            let previous_home = std::env::var_os("HOME");
            std::env::set_var("HOME", path);
            Self { previous_home }
        }
    }

    impl Drop for HomeEnvGuard {
        fn drop(&mut self) {
            match self.previous_home.take() {
                Some(previous_home) => std::env::set_var("HOME", previous_home),
                None => std::env::remove_var("HOME"),
            }
        }
    }

    #[test]
    fn discovers_skill_markdown_from_project_skills_fixture() {
        let _home_lock = home_env_lock()
            .lock()
            .expect("failed to lock HOME environment");
        let fake_home = std::env::temp_dir().join(format!(
            "atcontroller-workspace-home-test-{}",
            uuid::Uuid::new_v4()
        ));
        let _home_guard = HomeEnvGuard::set(&fake_home);
        let workspace =
            std::env::temp_dir().join(format!("atcontroller-skills-test-{}", uuid::Uuid::new_v4()));
        let skill_dir = workspace.join(".agents").join("skills").join("refactor");
        fs::create_dir_all(&fake_home).expect("failed to create fake HOME directory");
        fs::create_dir_all(&skill_dir).expect("failed to create fixture skill directory");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: refactor\ndescription: Improves refactor consistency.\n---\n\n# Refactor workflow\n\n## Entry Points\n- $refactor\n",
        )
        .expect("failed to write fixture SKILL.md");

        let discovered = list_skills(workspace.to_string_lossy().as_ref())
            .expect("skill listing should succeed");
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].id, "refactor");
        assert_eq!(discovered[0].name, "refactor");
        assert_eq!(discovered[0].description, "Improves refactor consistency.");
        assert_eq!(
            discovered[0].relative_path,
            ".agents/skills/refactor/SKILL.md"
        );
        assert!(!discovered[0].is_global);
        assert!(discovered[0].warning.is_none());
        assert!(discovered[0]
            .entry_points
            .iter()
            .any(|entry| entry.contains("$refactor")));

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(fake_home);
    }

    #[test]
    fn discovers_repository_skills_from_nested_workspace() {
        let _home_lock = home_env_lock()
            .lock()
            .expect("failed to lock HOME environment");
        let fake_home = std::env::temp_dir().join(format!(
            "atcontroller-ancestor-home-test-{}",
            uuid::Uuid::new_v4()
        ));
        let _home_guard = HomeEnvGuard::set(&fake_home);
        let repository = std::env::temp_dir().join(format!(
            "atcontroller-ancestor-skills-test-{}",
            uuid::Uuid::new_v4()
        ));
        let workspace = repository.join("packages").join("desktop");
        let skill_dir = repository.join(".agents").join("skills").join("review");
        fs::create_dir_all(&fake_home).expect("failed to create fake HOME directory");
        fs::create_dir_all(repository.join(".git")).expect("failed to create repository marker");
        fs::create_dir_all(&skill_dir).expect("failed to create fixture skill directory");
        fs::create_dir_all(&workspace).expect("failed to create nested workspace");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: review\ndescription: Review comments carefully.\n---\n\nFollow the repository review workflow.\n",
        )
        .expect("failed to write fixture SKILL.md");

        let discovered = list_skills(workspace.to_string_lossy().as_ref())
            .expect("skill listing should succeed");
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].id, "review");
        assert_eq!(discovered[0].name, "review");
        assert_eq!(
            discovered[0].relative_path,
            "../../.agents/skills/review/SKILL.md"
        );
        assert!(!discovered[0].is_global);

        let _ = fs::remove_dir_all(repository);
        let _ = fs::remove_dir_all(fake_home);
    }

    #[test]
    fn discovers_skill_markdown_from_global_skills_dir() {
        let _home_lock = home_env_lock()
            .lock()
            .expect("failed to lock HOME environment");
        let fake_home = std::env::temp_dir().join(format!(
            "atcontroller-global-home-test-{}",
            uuid::Uuid::new_v4()
        ));
        let _home_guard = HomeEnvGuard::set(&fake_home);
        let workspace = std::env::temp_dir().join(format!(
            "atcontroller-global-skill-workspace-{}",
            uuid::Uuid::new_v4()
        ));
        let skill_dir = fake_home
            .join(".agents")
            .join("skills")
            .join("global-review");
        fs::create_dir_all(&skill_dir).expect("failed to create global skill directory");
        fs::create_dir_all(&workspace).expect("failed to create workspace directory");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: global-review\ndescription: Available in every workspace.\n---\n\nUse this skill for review tasks.\n",
        )
        .expect("failed to write global SKILL.md");

        let discovered = list_skills(workspace.to_string_lossy().as_ref())
            .expect("skill listing should succeed");
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].id, "global-review");
        assert_eq!(discovered[0].name, "global-review");
        assert_eq!(
            discovered[0].relative_path,
            "~/.agents/skills/global-review/SKILL.md"
        );
        assert!(discovered[0].is_global);

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(fake_home);
    }

    #[test]
    fn workspace_skills_take_priority_over_global_skills_with_same_id() {
        let _home_lock = home_env_lock()
            .lock()
            .expect("failed to lock HOME environment");
        let fake_home = std::env::temp_dir().join(format!(
            "atcontroller-global-priority-home-test-{}",
            uuid::Uuid::new_v4()
        ));
        let _home_guard = HomeEnvGuard::set(&fake_home);
        let workspace = std::env::temp_dir().join(format!(
            "atcontroller-global-priority-workspace-test-{}",
            uuid::Uuid::new_v4()
        ));
        let global_skill_dir = fake_home.join(".agents").join("skills").join("review");
        let workspace_skill_dir = workspace.join(".agents").join("skills").join("review");
        fs::create_dir_all(&global_skill_dir).expect("failed to create global skill directory");
        fs::create_dir_all(&workspace_skill_dir)
            .expect("failed to create workspace skill directory");
        fs::write(
            global_skill_dir.join("SKILL.md"),
            "---\nname: review\ndescription: Global version.\n---\n",
        )
        .expect("failed to write global SKILL.md");
        fs::write(
            workspace_skill_dir.join("SKILL.md"),
            "---\nname: review\ndescription: Workspace version.\n---\n",
        )
        .expect("failed to write workspace SKILL.md");

        let discovered = list_skills(workspace.to_string_lossy().as_ref())
            .expect("skill listing should succeed");
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].id, "review");
        assert_eq!(discovered[0].name, "review");
        assert_eq!(
            discovered[0].relative_path,
            ".agents/skills/review/SKILL.md"
        );
        assert!(!discovered[0].is_global);

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(fake_home);
    }

    #[test]
    fn parses_required_yaml_metadata_and_common_scalar_styles() {
        let parsed = parse_skill_markdown(
            "\u{feff}---\nname: 'release-check'\ndescription: >-\n  Validate release names, signatures,\n  and bundle metadata.\n---\n\n# Ignored display heading\n",
            "release-check",
        );

        assert_eq!(parsed.name, "release-check");
        assert_eq!(
            parsed.description,
            "Validate release names, signatures, and bundle metadata."
        );
        assert!(parsed.warning.is_none());

        let quoted = parse_skill_markdown(
            "---\nname: \"review-helper\"\ndescription: \"Use when a request includes #review or a colon: value.\"\n---\n",
            "review-helper",
        );
        assert_eq!(quoted.name, "review-helper");
        assert_eq!(
            quoted.description,
            "Use when a request includes #review or a colon: value."
        );
        assert!(quoted.warning.is_none());

        let literal = parse_skill_markdown(
            "---\nname: delimiter-test\ndescription: |\n  Preserve an indented delimiter:\n  ---\n  when parsing metadata.\n---\n",
            "delimiter-test",
        );
        assert_eq!(
            literal.description,
            "Preserve an indented delimiter:\n---\nwhen parsing metadata."
        );
        assert!(literal.warning.is_none());
    }

    #[test]
    fn warns_and_uses_human_friendly_fallback_for_invalid_metadata() {
        let missing_front_matter = parse_skill_markdown(
            "# Friendly Review\n\nReview the current change carefully.\n",
            "review",
        );
        assert_eq!(missing_front_matter.name, "Friendly Review");
        assert_eq!(
            missing_front_matter.description,
            "Review the current change carefully."
        );
        assert!(missing_front_matter
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("required name and description")));

        let missing_description = parse_skill_markdown(
            "---\nname: review\n---\n\n# Fallback title\n\nFallback description.\n",
            "review",
        );
        assert_eq!(missing_description.name, "review");
        assert_eq!(missing_description.description, "Fallback description.");
        assert!(missing_description
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("description")));

        let mismatched_name = parse_skill_markdown(
            "---\nname: another-folder\ndescription: Valid description.\n---\n\n# Friendly name\n",
            "actual-folder",
        );
        assert_eq!(mismatched_name.name, "Friendly name");
        assert!(mismatched_name
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("parent folder")));
    }

    #[cfg(unix)]
    #[test]
    fn discovers_symlinked_skill_folders() {
        use std::os::unix::fs::symlink;

        let _home_lock = home_env_lock()
            .lock()
            .expect("failed to lock HOME environment");
        let fake_home = std::env::temp_dir().join(format!(
            "atcontroller-symlink-home-test-{}",
            uuid::Uuid::new_v4()
        ));
        let _home_guard = HomeEnvGuard::set(&fake_home);
        let workspace = std::env::temp_dir().join(format!(
            "atcontroller-symlink-workspace-test-{}",
            uuid::Uuid::new_v4()
        ));
        let skill_target = std::env::temp_dir().join(format!(
            "atcontroller-symlink-target-test-{}",
            uuid::Uuid::new_v4()
        ));
        let skills_root = workspace.join(".agents").join("skills");
        fs::create_dir_all(&fake_home).expect("failed to create fake HOME directory");
        fs::create_dir_all(&skills_root).expect("failed to create skills root");
        fs::create_dir_all(&skill_target).expect("failed to create symlink target");
        fs::write(
            skill_target.join("SKILL.md"),
            "---\nname: linked-review\ndescription: Review through a linked folder.\n---\n",
        )
        .expect("failed to write linked skill");
        symlink(&skill_target, skills_root.join("linked-review"))
            .expect("failed to link skill directory");

        let discovered = list_skills(workspace.to_string_lossy().as_ref())
            .expect("skill listing should succeed");
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].id, "linked-review");
        assert_eq!(discovered[0].name, "linked-review");
        assert!(discovered[0].warning.is_none());

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(skill_target);
        let _ = fs::remove_dir_all(fake_home);
    }
}
