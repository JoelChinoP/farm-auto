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

for (const file of files) {
  test(`${file} is a complete package with matching graph pointers`, async () => {
    const text = await readFile(resolve(process.cwd(), "automations", file), "utf8");
    const parsed = JSON.parse(text) as {
      name: string;
      script: {
        id: string;
        variables: Array<{ value: unknown }>;
        flow: { nodes: NodeData[]; edges: EdgeData[] };
      };
    };

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
