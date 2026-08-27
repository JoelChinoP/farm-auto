import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const files = [
  "device-home.genfarm",
  "open-social-content.genfarm",
  "whatsapp-send-consented.genfarm",
];

type NodeData = {
  id: string;
  data: { successNode: string | null; failNode: string | null };
};

type EdgeData = { source: string; target: string; sourceHandle: string };

type AutomationPackage = {
  name: string;
  input?: Array<{
    type: string;
    options: {
      value: unknown;
      variable?: { id: string; name: string; value: unknown };
    };
  }>;
  script: {
    id: string;
    variables: Array<{ id: string; name: string; value: unknown }>;
    flow: {
      nodes: Array<
        NodeData & {
          data: NodeData["data"] & {
            action?: string;
            options?: Record<string, unknown>;
          };
        }
      >;
      edges: EdgeData[];
    };
  };
};

for (const file of files) {
  test(`${file} is a complete package with matching graph pointers`, async () => {
    const text = await readFile(resolve(process.cwd(), "automations", file), "utf8");
    const parsed = JSON.parse(text) as AutomationPackage;

    assert.ok(parsed.name);
    assert.ok(parsed.script.id);
    const nodeIds = new Set(parsed.script.flow.nodes.map((node) => node.id));
    for (const node of parsed.script.flow.nodes) {
      for (const [pointer, handle] of [
        [node.data.successNode, "success"],
        [node.data.failNode, "fail"],
      ] as const) {
        if (!pointer) continue;
        assert.ok(nodeIds.has(pointer), `${node.id} points to missing ${pointer}`);
        assert.ok(
          parsed.script.flow.edges.some(
            (edge) =>
              edge.source === node.id &&
              edge.target === pointer &&
              (node.id.endsWith("_start") || edge.sourceHandle === handle),
          ),
          `${node.id} -> ${pointer} has no matching edge`,
        );
      }
    }

    for (const variable of parsed.script.variables) {
      assert.equal(variable.value, "", `${file} embeds an operational value`);
    }
  });
}

test("open-social-content exposes its parameters and starts the selected app", async () => {
  const text = await readFile(
    resolve(process.cwd(), "automations", "open-social-content.genfarm"),
    "utf8",
  );
  const parsed = JSON.parse(text) as AutomationPackage;
  const variables = new Map(
    parsed.script.variables.map((variable) => [variable.id, variable]),
  );

  assert.deepEqual(
    parsed.input?.map((field) => field.options.variable?.name),
    ["contentUrl", "packageName"],
  );
  for (const field of parsed.input ?? []) {
    const variable = field.options.variable;
    assert.ok(variable, `${field.type} is not linked to a variable`);
    assert.equal(variable.value, "");
    assert.deepEqual(variable, variables.get(variable.id));
  }

  const startApp = parsed.script.flow.nodes.find(
    (node) => node.data.action === "StartApp",
  );
  assert.ok(startApp, "StartApp node is missing");
  assert.equal(startApp.data.options?.packageName, "${packageName}");

  const openContent = parsed.script.flow.nodes.find(
    (node) => node.data.action === "Adb",
  );
  assert.match(String(openContent?.data.options?.command), /\$\{contentUrl\}/);
});
