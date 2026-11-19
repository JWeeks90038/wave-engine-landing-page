const { getAuth } = require("firebase-admin/auth");
const { firebaseApp } = require("./apparel-inventory");

async function main() {
  const uid = process.argv[2];
  if (!uid) throw new Error("Provide the Firebase Authentication user UID.");
  const auth = getAuth(firebaseApp());
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, { ...user.customClaims, admin: true });
  console.log("Admin claim granted. The user must sign out and back in.");
}

main().catch((error) => {
  console.error("Could not grant admin access:", error.message);
  process.exitCode = 1;
});
