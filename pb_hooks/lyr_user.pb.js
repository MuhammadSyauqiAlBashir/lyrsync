/// <reference path="../pb_data/types.d.ts" />
// CLI: pocketbase lyr-user <credentials-file> [admin]
// The file holds two lines: username, then password. Creates an approved
// lyrsync login (or resets its password); "admin" also grants the admin role.
// Reading from a file keeps the password out of shell history and the process
// list; delete the file afterwards.
$app.rootCmd.addCommand(new Command({
  use: "lyr-user",
  short: "create or reset an approved lyrsync login from a credentials file",
  run: (cmd, args) => {
    const admin = args.includes("admin")
    const files = args.filter((a) => a !== "admin")
    if (files.length !== 1) throw new Error("usage: lyr-user <credentials-file> [admin]")

    const raw = $os.readFile(files[0])
    const text = typeof raw === "string" ? raw : String.fromCharCode(...raw)
    const [username, password] = text.split("\n").map((s) => s.trim())
    if (!/^[a-z0-9_]{3,32}$/.test(username || "")) throw new Error("bad username (a-z, 0-9, _; 3-32 chars)")
    if (!password || password.length < 8) throw new Error("password must be at least 8 characters")

    const users = $app.findCollectionByNameOrId("users")
    let record
    try {
      record = $app.findFirstRecordByData(users, "username", username)
    } catch (_) {
      record = new Record(users)
      record.set("username", username)
      record.set("email", username + "@users.lyrsync.local")
    }
    record.set("approved", true)
    if (admin) record.set("role", "admin")
    record.setPassword(password)
    $app.save(record)
    console.log("lyrsync login '" + username + "' saved" + (admin ? " (admin)" : ""))
  },
}))
