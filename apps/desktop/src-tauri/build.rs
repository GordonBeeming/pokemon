fn main() {
    println!("cargo:rerun-if-env-changed=POKEDEX_DEV_CLOUD_BASE_URL");
    tauri_build::build()
}
