import { Walker } from "json-schema-walker";
import type { JSONSchema } from "./types.js";

const RESOURCE_TYPE_PREFIX = "resource-";

export const extractResourceTypeFromSchema = (schema: JSONSchema) => {
  if (
    schema.type !== "object" ||
    !schema.format?.startsWith(RESOURCE_TYPE_PREFIX)
  ) {
    return false;
  }

  return {
    resourceType: schema.format.slice(RESOURCE_TYPE_PREFIX.length),
  };
};

export const collectResourceTypes = (schema: JSONSchema) => {
  const walker = new Walker();
  walker.loadSchema(schema, {
    dereference: false,
  });

  const resourceTypes = new Set<string>();
  walker.walk((schema) => {
    const result = extractResourceTypeFromSchema(schema);
    if (!result) {
      return;
    }

    resourceTypes.add(result.resourceType);
  }, walker.vocabularies.DRAFT_07);

  return resourceTypes;
};
