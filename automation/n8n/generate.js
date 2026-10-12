import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = path.dirname(fileURLToPath(import.meta.url));
const id = (name) =>
  createHash("sha256").update(name).digest("hex").slice(0, 16);
const node = (name, type, parameters, position, version = 1, extra = {}) => ({
  id: id(name),
  name,
  type: "n8n-nodes-base." + type,
  typeVersion: version,
  position,
  parameters,
  ...extra,
});
const connect = (connections, from, to, index = 0) => {
  connections[from] ??= { main: [] };
  connections[from].main[index] ??= [];
  connections[from].main[index].push({ node: to, type: "main", index: 0 });
};
export const validateCode = `const b=$json.body??$json;
const fail=()=>[{json:{valid:false,ok:false,error:'INVALID_REQUEST',httpStatus:400}}];
if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['sessionId','messages'].includes(k)))return fail();
if(typeof b.sessionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(b.sessionId)||!Array.isArray(b.messages)||!b.messages.length||b.messages.length>100)return fail();
let size=0;for(const m of b.messages){if(!m||Object.keys(m).some(k=>!['role','content','timestamp'].includes(k))||!['user','assistant','system'].includes(m.role)||typeof m.content!=='string'||!m.content.trim()||m.content.length>16000||(size+=m.content.length)>48000||typeof m.timestamp!=='string'||!Number.isFinite(Date.parse(m.timestamp)))return fail();}
return [{json:{valid:true,payload:{sessionId:b.sessionId,messages:b.messages}}}];`;
export const outcomeCode = `const raw=$json.body??$json;
const status=Number($json.statusCode??(raw.error?503:200));
const ok=status>=200&&status<300&&raw.ok!==false&&!raw.error;
return [{json:{ok,httpStatus:ok?200:(status>=400?status:503),status:ok?'completed':'needs-attention',candidates:Array.isArray(raw.observations??raw.result?.observations)?(raw.observations??raw.result.observations).length:0,rejected:Array.isArray(raw.rejectedCandidates??raw.result?.rejectedCandidates)?(raw.rejectedCandidates??raw.result.rejectedCandidates).length:0,notifications:Array.isArray(raw.notifications)?raw.notifications.length:0,dryRun:raw.dryRun??null,checks:Array.isArray(raw.checks)?raw.checks.map(c=>({name:c.name,ok:c.ok,code:c.code??null})):undefined,backupVerified:raw.files!==undefined&&raw.ok===true,sourceStatus:typeof raw.status==='string'?raw.status:null}}];`;
export function buildWorkflows() {
  const definitions = [
    {
      name: "01 June memory candidate intake",
      key: "candidates",
      endpoint: "/v1/process",
      webhook: true,
    },
    {
      name: "02 June daily memory consolidation",
      key: "consolidation",
      endpoint: "/v1/jobs/consolidate",
      cron: "0 3 * * *",
      payload: { dryRun: true },
    },
    {
      name: "03 June deadline and commitment reminders",
      key: "reminders",
      endpoint: "/v1/jobs/reminders",
      cron: "0 * * * *",
      payload: { leadHours: 24, dryRun: true },
    },
    {
      name: "04 June health and recovery checks",
      key: "health",
      endpoint: "/v1/jobs/health",
      cron: "*/15 * * * *",
      payload: {},
    },
    {
      name: "05 June backup verification",
      key: "backup",
      endpoint: "/v1/jobs/backup",
      cron: "0 4 * * *",
      payload: {},
    },
  ];
  return definitions.map((d) => {
    const nodes = [node("Manual test", "manualTrigger", {}, [0, 300])],
      connections = {};
    if (d.webhook) {
      nodes.push(
        node(
          "Authenticated local webhook",
          "webhook",
          {
            httpMethod: "POST",
            path: "june-memory-candidates",
            authentication: "headerAuth",
            responseMode: "responseNode",
            options: {},
          },
          [0, 0],
          2.1,
          {
            webhookId: id("june-local-webhook"),
            credentials: {
              httpHeaderAuth: {
                id: "june-webhook-header",
                name: "June inbound webhook",
              },
            },
          },
        ),
      );
      nodes.push(
        node(
          "Synthetic manual example",
          "code",
          {
            jsCode: `return [{json:{sessionId:'n8n-synthetic-'+$execution.id,messages:[{role:'user',content:'I prefer written plans.',timestamp:new Date().toISOString()}]}}];`,
          },
          [220, 300],
          2,
        ),
      );
      nodes.push(
        node(
          "Validate bounded candidate",
          "code",
          { jsCode: validateCode },
          [440, 0],
          2,
        ),
      );
      nodes.push(
        node(
          "Valid request",
          "if",
          {
            conditions: {
              options: {
                caseSensitive: true,
                leftValue: "",
                typeValidation: "strict",
                version: 2,
              },
              combinator: "and",
              conditions: [
                {
                  id: id("valid-condition"),
                  leftValue: "={{ $json.valid }}",
                  rightValue: true,
                  operator: {
                    type: "boolean",
                    operation: "true",
                    singleValue: true,
                  },
                },
              ],
            },
            options: {},
          },
          [660, 0],
          2.2,
        ),
      );
      connect(connections, "Manual test", "Synthetic manual example");
      connect(
        connections,
        "Synthetic manual example",
        "Validate bounded candidate",
      );
      connect(
        connections,
        "Authenticated local webhook",
        "Validate bounded candidate",
      );
      connect(connections, "Validate bounded candidate", "Valid request");
      connect(connections, "Valid request", "Memory engine", 0);
      connect(connections, "Valid request", "Respond locally", 1);
    } else {
      nodes.push(
        node(
          "Local schedule",
          "scheduleTrigger",
          {
            rule: {
              interval: [{ field: "cronExpression", expression: d.cron }],
            },
          },
          [0, 0],
          1.3,
        ),
      );
      nodes.push(
        node(
          "Job configuration",
          "code",
          {
            jsCode:
              "return [{json:{payload:" + JSON.stringify(d.payload) + "}}];",
          },
          [440, 0],
          2,
        ),
      );
      connect(connections, "Manual test", "Job configuration");
      connect(connections, "Local schedule", "Job configuration");
      connect(connections, "Job configuration", "Memory engine");
    }
    nodes.push(
      node(
        "Memory engine",
        "httpRequest",
        {
          method: "POST",
          url: "http://127.0.0.1:3210" + d.endpoint,
          authentication: "genericCredentialType",
          genericAuthType: "httpHeaderAuth",
          sendBody: true,
          specifyBody: "json",
          jsonBody: "={{ $json.payload }}",
          options: {
            timeout: 240000,
            response: {
              response: {
                fullResponse: true,
                neverError: true,
                responseFormat: "json",
              },
            },
          },
        },
        [880, 0],
        4.4,
        {
          credentials: {
            httpHeaderAuth: {
              id: "june-memory-worker",
              name: "June Memory worker (local)",
            },
          },
          onError: "continueErrorOutput",
        },
      ),
    );
    nodes.push(
      node("Sanitized result", "code", { jsCode: outcomeCode }, [1100, 0], 2),
    );
    connect(connections, "Memory engine", "Sanitized result", 0);
    connect(connections, "Memory engine", "Sanitized result", 1);
    if (d.webhook) {
      nodes.push(
        node(
          "Respond locally",
          "respondToWebhook",
          {
            respondWith: "json",
            responseBody: "={{ $json }}",
            options: { responseCode: "={{ $json.httpStatus }}" },
          },
          [1320, 0],
          1.5,
        ),
      );
      connect(connections, "Sanitized result", "Respond locally");
    }
    return {
      id: "june-" + d.key,
      name: d.name,
      active: false,
      nodes,
      connections,
      settings: {
        executionOrder: "v1",
        timezone: "Asia/Calcutta",
        saveDataErrorExecution: "none",
        saveDataSuccessExecution: "none",
        saveManualExecutions: false,
        saveExecutionProgress: false,
        executionTimeout: 300,
      },
      pinData: {},
      tags: [],
    };
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await fs.mkdir(path.join(root, "workflows"), { recursive: true });
  for (const workflow of buildWorkflows())
    await fs.writeFile(
      path.join(root, "workflows", workflow.id + ".json"),
      JSON.stringify(workflow, null, 2) + "\n",
    );
  console.log("Generated five inactive local workflows.");
}
