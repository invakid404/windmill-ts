import { Walker } from "json-schema-walker";
import type { JSONSchema } from "./types.js";

const RESOURCE_TYPE_PREFIX = "resource-";

export const collectResourceTypes = (schema: JSONSchema) => {
  const walker = new Walker();
  walker.loadSchema(schema, {
    dereference: false,
  });

  const resourceTypes = new Set<string>();
  walker.walk((schema) => {
    if (
      schema.type !== "object" ||
      !schema.format?.startsWith(RESOURCE_TYPE_PREFIX)
    ) {
      return;
    }

    const name = schema.format.slice(RESOURCE_TYPE_PREFIX.length);
    resourceTypes.add(name);
  }, walker.vocabularies.DRAFT_07);

  return resourceTypes;
};
