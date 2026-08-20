// One reviewed deterministic calculator is shared by the browser and the
// deployable Functions package. The server copy owns the implementation so the
// de-identified provider evidence cannot drift from local Insights behavior.
export * from "../../functions/insights/classInsights.js";
