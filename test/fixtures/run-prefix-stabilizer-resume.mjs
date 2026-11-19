import { pathToFileURL } from "node:url";

const { default: activate } = await import(pathToFileURL(process.argv[2]).href);
const entries = [];
const notifications = [];
const payloads = [];
const context = {
  cwd: process.cwd(),
  isProjectTrusted: () => false,
  model: { provider: "fixture", id: "glm" },
  ui: { notify: (message) => notifications.push(message) },
  sessionManager: { getEntries: () => entries, getBranch: () => entries },
};

for (const phase of JSON.parse(process.env.PREFIX_STABILIZER_TEST_RESUMES)) {
  const handlers = new Map();
  activate({
    on: (name, handler) => handlers.set(name, handler),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  });
  await handlers.get("session_start")?.({}, context);
  for (const payload of phase)
    payloads.push(await handlers.get("before_provider_request")({ payload }, context) ?? payload);
}

process.stdout.write(JSON.stringify({ notifications, entries, payloads }));
