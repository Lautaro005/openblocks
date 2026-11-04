//! Talking to the operating system: folder picker, opening files and links with the default app,
//! showing a file in Finder/Explorer.

use std::path::{Path, PathBuf};

use crate::util::command;

/// Shows the system's folder dialog. Returns `None` when the user cancels or there is no dialog.
pub fn pick_folder(prompt: &str) -> Option<PathBuf> {
    let out = if cfg!(target_os = "macos") {
        let p = prompt.replace('"', "'");
        command("osascript")
            .args([
                "-e",
                &format!("POSIX path of (choose folder with prompt \"{p}\")"),
            ])
            .output()
            .ok()?
    } else if cfg!(windows) {
        let script = "Add-Type -AssemblyName System.Windows.Forms; \
            $d = New-Object System.Windows.Forms.FolderBrowserDialog; \
            $d.ShowNewFolderButton = $true; \
            if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }";
        command("powershell")
            .args(["-NoProfile", "-STA", "-Command", script])
            .output()
            .ok()?
    } else if crate::util::which("zenity").is_some() {
        command("zenity")
            .args(["--file-selection", "--directory", "--title", prompt])
            .output()
            .ok()?
    } else if crate::util::which("kdialog").is_some() {
        command("kdialog")
            .args(["--getexistingdirectory", "~", "--title", prompt])
            .output()
            .ok()?
    } else {
        return None;
    };
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s.trim_end_matches('/')))
    }
}

/// Shows the system's file dialog for one or more `.zip` files.
pub fn pick_zips(prompt: &str) -> Option<Vec<PathBuf>> {
    let out = if cfg!(target_os = "macos") {
        let p = prompt.replace('"', "'");
        let script = format!(
            "set fs to choose file with prompt \"{p}\" of type {{\"zip\", \"public.zip-archive\"}} with multiple selections allowed\n\
             set o to \"\"\n\
             repeat with f in fs\n set o to o & POSIX path of f & linefeed\n end repeat\n\
             return o"
        );
        command("osascript").args(["-e", &script]).output().ok()?
    } else if cfg!(windows) {
        let script = "Add-Type -AssemblyName System.Windows.Forms; \
            $d = New-Object System.Windows.Forms.OpenFileDialog; \
            $d.Filter = 'Zip (*.zip)|*.zip'; $d.Multiselect = $true; \
            if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write(($d.FileNames -join \"`n\")) }";
        command("powershell")
            .args(["-NoProfile", "-STA", "-Command", script])
            .output()
            .ok()?
    } else if crate::util::which("zenity").is_some() {
        command("zenity")
            .args([
                "--file-selection",
                "--multiple",
                "--separator=\n",
                "--file-filter=*.zip",
                "--title",
                prompt,
            ])
            .output()
            .ok()?
    } else if crate::util::which("kdialog").is_some() {
        command("kdialog")
            .args([
                "--getopenfilename",
                "~",
                "*.zip",
                "--multiple",
                "--separate-output",
                "--title",
                prompt,
            ])
            .output()
            .ok()?
    } else {
        return None;
    };
    if !out.status.success() {
        return None;
    }
    let v: Vec<PathBuf> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(PathBuf::from)
        .collect();
    (!v.is_empty()).then_some(v)
}

/// Opens a file or folder with its default app.
pub fn open_path(p: &Path) -> std::io::Result<()> {
    let mut c = if cfg!(target_os = "macos") {
        let mut c = command("open");
        c.arg(p);
        c
    } else if cfg!(windows) {
        let mut c = command("explorer");
        c.arg(p);
        c
    } else {
        let mut c = command("xdg-open");
        c.arg(p);
        c
    };
    c.spawn().map(|_| ())
}

/// Shows a file in Finder / Explorer / the file manager.
pub fn reveal(p: &Path) -> std::io::Result<()> {
    if cfg!(target_os = "macos") {
        command("open").arg("-R").arg(p).spawn().map(|_| ())
    } else if cfg!(windows) {
        command("explorer")
            .arg(format!("/select,{}", p.display()))
            .spawn()
            .map(|_| ())
    } else {
        open_path(p.parent().unwrap_or(p))
    }
}

/// Opens an http(s) or mailto link in the default browser.
pub fn open_url(url: &str) -> std::io::Result<()> {
    let ok =
        url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:");
    if !ok {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "unsupported link",
        ));
    }
    if cfg!(target_os = "macos") {
        command("open").arg(url).spawn().map(|_| ())
    } else if cfg!(windows) {
        command("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
            .map(|_| ())
    } else {
        command("xdg-open").arg(url).spawn().map(|_| ())
    }
}
