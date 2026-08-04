import { test } from "node:test";
import assert from "node:assert/strict";

import { connectPhase2bEmulatorsIfConfigured } from "../firebase/firebase.js";

test("omitting forceLongPolling preserves the default Firestore transport", () => {
  const result = connectPhase2bEmulatorsIfConfigured({
    enabled: true,
    projectId: "demo-morgan-bank-default-transport-test",
    host: "127.0.0.1",
    authPort: 9099,
    firestorePort: 8080,
    functionsPort: 5001
  });

  assert.equal(result.connected, true);
  assert.equal(result.app.options.projectId, "demo-morgan-bank-default-transport-test");
  assert.equal(
    result.db._settings.experimentalForceLongPolling,
    false,
    "the omitted transport option must use the normal Firestore configuration"
  );
});
