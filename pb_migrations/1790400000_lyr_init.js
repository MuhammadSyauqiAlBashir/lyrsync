/// <reference path="../pb_data/types.d.ts" />
// lyrsync: username login on `users`, open registration gated by admin
// approval, and per-user history/favourites collections. Other apps share this
// PocketBase, so the lyrsync collections are prefixed `lyr_`.
migrate((app) => {
  const users = app.findCollectionByNameOrId("users")

  if (!users.fields.getByName("username")) {
    users.fields.add(new TextField({
      name: "username",
      required: true,
      min: 3,
      max: 32,
      pattern: "^[a-z0-9_]+$",
      presentable: true,
    }))
    users.addIndex("idx_users_username", true, "username", "")
  }
  if (!users.fields.getByName("approved")) {
    users.fields.add(new BoolField({ name: "approved" }))
  }
  if (!users.fields.getByName("role")) {
    users.fields.add(new SelectField({ name: "role", maxSelect: 1, values: ["admin"] }))
  }
  users.passwordAuth.enabled = true
  users.passwordAuth.identityFields = ["username"]

  const isAdmin = "@request.auth.role = 'admin'"
  // Anyone may register, but can't pre-approve themselves or pick a role.
  users.createRule = "@request.body.approved:isset = false && @request.body.role:isset = false"
  // Unapproved accounts can't log in or refresh a token.
  users.authRule = "approved = true"
  users.listRule = "id = @request.auth.id || " + isAdmin
  users.viewRule = "id = @request.auth.id || " + isAdmin
  // Users may edit themselves (e.g. change password, which PocketBase guards
  // with oldPassword) but never their approval, role or username. Admins may
  // approve or revoke other accounts.
  const selfEdit = "id = @request.auth.id && @request.body.approved:isset = false" +
    " && @request.body.role:isset = false && @request.body.username:isset = false"
  users.updateRule = "(" + selfEdit + ") || (" + isAdmin + " && id != @request.auth.id)"
  users.deleteRule = isAdmin + " && id != @request.auth.id"
  users.oauth2.enabled = false
  users.otp.enabled = false
  users.authToken.duration = 30 * 24 * 60 * 60 // refreshed on use by the backend
  app.save(users)

  const ownerOnly = "user = @request.auth.id"
  const trackFields = () => [
    { type: "relation", name: "user", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true },
    { type: "text", name: "track_id", required: true, max: 100 },
    { type: "text", name: "title", required: true, max: 300 },
    { type: "text", name: "artist", max: 300 },
    { type: "text", name: "album", max: 300 },
    { type: "text", name: "cover", max: 1000 },
    { type: "text", name: "apple_url", max: 1000 },
    { type: "text", name: "spotify_url", max: 1000 },
    { type: "text", name: "isrc", max: 20 },
    { type: "text", name: "source", max: 20 },
    { type: "number", name: "duration", min: 0, max: 7200 },
    { type: "number", name: "lrclib_id", min: 0, onlyInt: true },
    { type: "autodate", name: "created", onCreate: true, onUpdate: false },
  ]

  const history = new Collection({
    type: "base",
    name: "lyr_history",
    listRule: ownerOnly,
    viewRule: ownerOnly,
    createRule: "@request.auth.id != '' && " + ownerOnly,
    updateRule: null,
    deleteRule: ownerOnly,
    fields: trackFields(),
    indexes: ["CREATE INDEX idx_lyr_history_user_created ON lyr_history (user, created)"],
  })
  app.save(history)

  const favorites = new Collection({
    type: "base",
    name: "lyr_favorites",
    listRule: ownerOnly,
    viewRule: ownerOnly,
    createRule: "@request.auth.id != '' && " + ownerOnly,
    updateRule: null,
    deleteRule: ownerOnly,
    fields: trackFields(),
    indexes: ["CREATE UNIQUE INDEX idx_lyr_favorites_user_track ON lyr_favorites (user, track_id)"],
  })
  app.save(favorites)
}, (app) => {
  for (const name of ["lyr_favorites", "lyr_history"]) {
    try { app.delete(app.findCollectionByNameOrId(name)) } catch (_) {}
  }
  const users = app.findCollectionByNameOrId("users")
  users.passwordAuth.identityFields = ["email"]
  users.authRule = ""
  users.removeIndex("idx_users_username")
  for (const f of ["username", "approved", "role"]) users.fields.removeByName(f)
  app.save(users)
})
