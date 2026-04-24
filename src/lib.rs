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
                return Ok(SERVER_PATH.to_string());
            }
            Err(error) => {
                return Err(format!(
                    "Failed to resolve latest npm version for '{PACKAGE_NAME}': {error}"
                ));
            }
        };

        let installed_version = zed::npm_package_installed_version(PACKAGE_NAME)?;
        if !self.server_exists() || installed_version.as_ref() != Some(&latest_version) {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );

            let install_result = zed::npm_install_package(PACKAGE_NAME, &latest_version);
            if let Err(error) = install_result {
                if self.server_exists() {
                    self.checked_npm_package = true;
                    return Ok(SERVER_PATH.to_string());
                }

                zed::set_language_server_installation_status(
                    language_server_id,
                    &zed::LanguageServerInstallationStatus::Failed(error.clone()),
                );
                return Err(format!(
                    "Failed to install npm package '{PACKAGE_NAME}': {error}"
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

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![server_path],
            env: Default::default(),
        })
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

zed::register_extension!(ParaglideI18nExtension);
