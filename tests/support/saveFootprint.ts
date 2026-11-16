// a full-season save folder in a test was 100-300 MB. Cause: the production save store (FileSaveStore) fsyncs in the BACKGROUND by default, and "no durable version yet" keeps every
// file (up to 200 x ~0.7 MB at the finale) until the first background fsync completes; a test that drives a season in a SYNCHRONOUS loop never yields to the event loop, so none completes
// and nothing is pruned. The synchronous mode (the documented ORWELL_SAVE_FSYNC=sync kill switch) syncs and prunes inside each save, so the folder stays at the recent window + checkpoints
// (a few MB). The save tests that exercise a mode pass it explicitly (`fsyncMode`) or set the variable themselves, so they are unaffected.
process.env["ORWELL_SAVE_FSYNC"] ??= "sync";
