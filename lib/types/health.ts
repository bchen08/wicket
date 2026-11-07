// Shared contract between the API (Claude) and the UI (v0).
// Changing a type here is a breaking change: it needs its own PR, merged before UI work.

export type HealthResponse = {
  status: "ok";
  service: "emergent";
};
