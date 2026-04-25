use std::{env, fs, path::PathBuf};
use zed_extension_api::{self as zed, Result};

const DEV_SERVER_ENV: &str = "PARAGLIDE_ZED_LSP_SERVER";
const PACKAGE_NAME: &str = "paraglide-zed-lsp";
const SERVER_PATH: &str = "node_modules/paraglide-zed-lsp/dist/src/server.js";

struct ParaglideI18nExtension {
    checked_npm_package: bool,
}

impl ParaglideI18nExtension {
    fn server_exists(&self) -> bool {
        fs::metadata(SERVER_PATH).is_ok_and(|metadata| metadata.is_file())
    }

    fn server_script_path(&mut self, language_server_id: &zed::LanguageServerId) -> Result<String> {
        if let Some(server_path) = dev_server_entrypoint()? {
            return Ok(server_path.to_string_lossy().to_string());
        }

        if self.checked_npm_package && self.server_exists() {
            return Ok(SERVER_PATH.to_string());
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );

        let latest_version = match zed::npm_package_latest_version(PACKAGE_NAME) {
            Ok(version) => version,
            Err(_) if self.server_exists() => {
                self.checked_npm_package = true;
                clear_language_server_installation_status(language_server_id);
                return Ok(SERVER_PATH.to_string());
            }
            Err(error) => {
                let message =
                    format!("Failed to resolve latest npm version for '{PACKAGE_NAME}': {error}");
                return Err(fail_language_server_installation(
                    language_server_id,
                    message,
                ));
            }
        };

        let installed_version = match zed::npm_package_installed_version(PACKAGE_NAME) {
            Ok(version) => version,
            Err(error) => {
                let message = format!(
                    "Failed to resolve installed npm version for '{PACKAGE_NAME}': {error}"
                );
                return Err(fail_language_server_installation(
                    language_server_id,
                    message,
                ));
            }
        };
        if !self.server_exists() || installed_version.as_ref() != Some(&latest_version) {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );

            let install_result = zed::npm_install_package(PACKAGE_NAME, &latest_version);
            if let Err(error) = install_result {
                if self.server_exists() {
                    self.checked_npm_package = true;
                    clear_language_server_installation_status(language_server_id);
                    return Ok(SERVER_PATH.to_string());
                }

                let message = format!("Failed to install npm package '{PACKAGE_NAME}': {error}");
                return Err(fail_language_server_installation(
                    language_server_id,
                    message,
                ));
            }
        }

        if !self.server_exists() {
            let message = format!(
                "Installed npm package '{PACKAGE_NAME}' did not contain expected server path '{SERVER_PATH}'"
            );
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Failed(message.clone()),
            );
            return Err(message);
        }

        self.checked_npm_package = true;
        clear_language_server_installation_status(language_server_id);
        Ok(SERVER_PATH.to_string())
    }
}

impl zed::Extension for ParaglideI18nExtension {
    fn new() -> Self {
        Self {
            checked_npm_package: false,
        }
    }

    fn language_server_command(
        &mut self,
        id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let server_path = self.server_script_path(id)?;
        let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
        let server_arg = server_command_arg(&server_path, &cwd);

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![server_arg],
            env: Default::default(),
        })
    }
}

fn server_command_arg(server_path: &str, work_dir: &PathBuf) -> String {
    let path = std::path::Path::new(server_path);
    if path.is_absolute() {
        return server_path.to_string();
    }

    work_dir.join(path).to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_server_path_from_extension_work_dir() {
        let work_dir = PathBuf::from("/zed/extensions/work/paraglide-i18n");

        let resolved = server_command_arg(SERVER_PATH, &work_dir);

        assert_eq!(
            resolved,
            "/zed/extensions/work/paraglide-i18n/node_modules/paraglide-zed-lsp/dist/src/server.js"
        );
    }

    #[test]
    fn keeps_absolute_dev_server_path() {
        let work_dir = PathBuf::from("/zed/extensions/work/paraglide-i18n");
        let dev_server = "/repo/paraglide-zed-lsp/dist/src/server.js";

        let resolved = server_command_arg(dev_server, &work_dir);

        assert_eq!(resolved, dev_server);
    }
}

fn dev_server_entrypoint() -> Result<Option<PathBuf>> {
    let Ok(server_path) = env::var(DEV_SERVER_ENV) else {
        return Ok(None);
    };
    let server_path = server_path.trim();
    if server_path.is_empty() {
        return Ok(None);
    }

    let server_path = PathBuf::from(server_path);
    if !server_path.exists() {
        return Err(format!(
            "{DEV_SERVER_ENV} points to a missing Paraglide i18n LSP server: {}",
            server_path.to_string_lossy()
        ));
    }

    Ok(Some(server_path))
}

fn clear_language_server_installation_status(language_server_id: &zed::LanguageServerId) {
    zed::set_language_server_installation_status(
        language_server_id,
        &zed::LanguageServerInstallationStatus::None,
    );
}

fn fail_language_server_installation(
    language_server_id: &zed::LanguageServerId,
    message: String,
) -> String {
    zed::set_language_server_installation_status(
        language_server_id,
        &zed::LanguageServerInstallationStatus::Failed(message.clone()),
    );
    message
}

zed::register_extension!(ParaglideI18nExtension);
