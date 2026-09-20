fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 4 || args[0] != "--apply-empty-company-repair" {
        eprintln!("Usage: repair_empty_company_link --apply-empty-company-repair PROFILE EXPECTED_EMAIL PREVIOUS_ORGANIZATION. Close Zentra and back up the profile first.");
        std::process::exit(2);
    }
    match tauri::async_runtime::block_on(helvichantier_lib::repair_empty_company_link(args[1].clone().into(), &args[2], &args[3])) {
        Ok(report) => println!("{}", report),
        Err(error) => { eprintln!("{}", error); std::process::exit(1); }
    }
}
