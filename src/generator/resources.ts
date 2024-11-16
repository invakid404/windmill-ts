import toValidIdentifier from "to-valid-identifier";
import { jsonSchemaToZod } from "json-schema-to-zod";
import PQueue from "p-queue";
import { listResourcesByType } from "../windmill/resources.js";
import type { JSONSchema } from "./types.js";
import { getContext } from "./context.js";

export const generateResources = async (resourceTypes: string[]) => {
  const { write } = getContext()!;

  const resourceQueue = new PQueue({ concurrency: 5 });

  const resources = resourceTypes.map((resourceType) =>
    resourceQueue.add(
      async () => ({
        resourceType,
        paths: await Array.fromAsync(
          listResourcesByType(resourceType),
          ({ path }) => path,
        ),
      }),
      { throwOnTimeout: true },
    ),
  );

  for await (const { resourceType, paths } of resources) {
    const resourceSchema = makeResourceSchema(paths);

    const schemaName = toValidIdentifier(resourceType);
    const zodSchema = jsonSchemaToZod(resourceSchema);

    write(`const ${schemaName} = lazyObject(() => ${zodSchema});`);
  }
};

const makeResourceSchema = (paths: string[]) => {
  const refs = paths.map((path) => `$res:${path}`);

  return {
    type: "string",
    enum: refs,
    ...(refs.length === 1 && { default: refs[0] }),
  } satisfies JSONSchema;
};
