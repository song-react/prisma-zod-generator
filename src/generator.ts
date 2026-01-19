#!/usr/bin/env node

import { generatorHandler, type DMMF, type GeneratorOptions } from '@prisma/generator-helper';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const scalarMap: Record<string, string> = {
  String: 'z.string()',
  Int: 'z.number().int()',
  BigInt: 'z.bigint()',
  Float: 'z.number()',
  Decimal: 'z.number()',
  Boolean: 'z.boolean()',
  DateTime: 'z.date()',
  Json: 'z.any()',
  Bytes: 'z.instanceof(Buffer)',
};

interface GeneratorState {
  lines: string[];
  enumUsage: Map<string, string[]>;
  emittedModels: Set<string>;
}

let enumDefinitions = new Map<string, string[]>();

const PRIMITIVE_NEEDS_PARENS =
  /z\.(string|number|bigint|boolean|date|symbol|any|unknown|never|void|undefined|null|literal|object|map|set|record|enum)(?!\s*\()/g;
const ARRAY_INLINE_PATTERN = /\.array\(\s*(\.[^)]*)\)/g;

function indent(level: number): string {
  return '  '.repeat(level);
}

function normaliseExpression(expression: string): string {
  return expression
    .replace(PRIMITIVE_NEEDS_PARENS, (_match, type) => `z.${type}()`)
    .replace(ARRAY_INLINE_PATTERN, (_match, inner) => `.array()${inner}`);
}

function parseDocComment(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('@z')) return undefined;

  let body = trimmed;
  body = body.replace(/^@zod\s*\.?/, '').replace(/^@z\s*\.?/, '');

  const useMatch = body.match(/\.use\(([^]+)\)\s*$/s);
  if (useMatch) {
    return normaliseExpression(useMatch[1].trim());
  }

  if (!body.startsWith('z')) {
    body = `z.${body.startsWith('.') ? body.slice(1) : body}`;
  } else if (!body.startsWith('z.')) {
    body = `z.${body}`;
  }

  return normaliseExpression(body);
}

function ensureArray(expression: string, field: DMMF.Field): string {
  if (!field.isList) return expression;
  if (expression.includes('.array(') || expression.startsWith('z.array(')) {
    return expression;
  }
  return `z.array(${expression})`;
}

function ensureNullability(expression: string, field: DMMF.Field): string {
  if (field.isList) return expression;
  const shouldAllowNull = !field.isRequired;
  if (shouldAllowNull && !expression.includes('.nullable(') && !expression.includes('.nullish(')) {
    expression = `${expression}.nullable()`;
  }
  return expression;
}

function appendOptional(expression: string): string {
  if (expression.trimEnd().endsWith('.optional()')) {
    return expression;
  }
  return `${expression}.optional()`;
}

function maybeOptional(expression: string, field: DMMF.Field): string {
  const shouldBeOptional = !field.isRequired || field.hasDefaultValue;
  return shouldBeOptional ? appendOptional(expression) : expression;
}

function buildScalarExpression(field: DMMF.Field, state: GeneratorState): string {
  const docExpression = parseDocComment(field.documentation);
  let expression = docExpression;

  if (!expression) {
    if (field.kind === 'enum') {
      const values = enumDefinitions.get(field.type);
      if (values && values.length > 0) {
        if (!state.enumUsage.has(field.type)) {
          state.enumUsage.set(field.type, values);
        }
        expression = `${field.type}Schema`;
      } else {
        expression = 'z.string()';
      }
    } else {
      expression = scalarMap[field.type] ?? 'z.any()';
    }
  }

  expression = ensureArray(expression, field);
  expression = ensureNullability(expression, field);
  expression = maybeOptional(expression, field);
  return expression;
}

function uniqueFields(model: DMMF.Model): DMMF.Field[] {
  const map = new Map<string, DMMF.Field>();
  for (const field of model.fields) {
    if (field.isId || field.isUnique) {
      map.set(field.name, field);
    }
  }
  if (model.primaryKey) {
    for (const name of model.primaryKey.fields) {
      const field = model.fields.find(f => f.name === name);
      if (field) map.set(name, field);
    }
  }
  for (const group of model.uniqueFields) {
    for (const name of group) {
      const field = model.fields.find(f => f.name === name);
      if (field) map.set(name, field);
    }
  }
  return Array.from(map.values());
}

function buildUniqueCombos(model: DMMF.Model, uniques: DMMF.Field[]): DMMF.Field[][] {
  const fieldByName = new Map(model.fields.map(field => [field.name, field] as const));
  const combos: DMMF.Field[][] = [];
  const seen = new Set<string>();

  const addCombo = (names: readonly string[]) => {
    const distinctNames = Array.from(new Set(names));
    if (distinctNames.length === 0) return;
    const key = distinctNames.slice().sort().join('|');
    if (seen.has(key)) return;
    const fields = distinctNames
      .map(name => fieldByName.get(name))
      .filter((field): field is DMMF.Field => Boolean(field));
    if (fields.length !== distinctNames.length) return;
    seen.add(key);
    combos.push(fields);
  };

  for (const field of uniques) {
    addCombo([field.name]);
  }

  for (const group of model.uniqueFields ?? []) {
    addCombo(group);
  }

  if (model.primaryKey) {
    addCombo(model.primaryKey.fields);
  }

  const singleNames = Array.from(new Set(uniques.map(field => field.name)));
  if (singleNames.length > 1) {
    addCombo(singleNames);
  }

  return combos;
}

function wrapLazy(schemaName: string, useLazy: boolean): string {
  return useLazy ? `z.lazy(() => ${schemaName})` : schemaName;
}

function relationListConditionExpression(schemaName: string): string {
  return `whereRelationLazy(() => ${schemaName})`;
}

function relationWhereExpression(field: DMMF.Field, currentModel: string, state: GeneratorState): string {
  const relatedWhere = `${field.type}WhereInputSchema`;
  const needsLazy = field.type === currentModel || !state.emittedModels.has(field.type);
  let expression = field.isList ? relationListConditionExpression(relatedWhere) : wrapLazy(relatedWhere, needsLazy);
  if (field.type === currentModel && !field.isList) {
    const prismaType = `Prisma.${currentModel}WhereInput[${JSON.stringify(field.name)}]`;
    expression = `${expression} as z.ZodType<${prismaType}>`;
  }
  return expression;
}

function shapeRef(modelName: string, fieldName: string): string {
  return `${modelName}Schema.shape[${JSON.stringify(fieldName)}]`;
}

function shapeRefForWhere(modelName: string, field: DMMF.Field): string {
  if (field.isList) {
    const prismaType = `Prisma.${modelName}WhereInput[${JSON.stringify(field.name)}]`;
    return `z.custom<${prismaType}>()`;
  }
  return shapeRef(modelName, field.name);
}

function pushModelSchemas(model: DMMF.Model, state: GeneratorState) {
  const { lines } = state;
  const scalarFields = model.fields.filter(field => field.kind !== 'object');
  const relationFields = model.fields.filter(field => field.kind === 'object');

  const modelName = model.name;

  const includeName = `${modelName}IncludeSchema`;
  const includeObjectName = `${modelName}IncludeObjectSchema`;
  const whereName = `${modelName}WhereInputSchema`;
  const whereUniqueName = `${modelName}WhereUniqueInputSchema`;
  const whereObjectName = `${modelName}WhereInputObjectSchema`;

  const createInputName = `${modelName}CreateInputSchema`;
  const updateInputName = `${modelName}UpdateInputSchema`;

  lines.push(`// ${modelName}`);
  // Schema
  lines.push(`export const ${modelName}Schema = z.object({`);
  for (const field of scalarFields) {
    const expression = buildScalarExpression(field, state);
    lines.push(`${indent(1)}${field.name}: ${expression},`);
  }
  lines.push('}).strip();', '');

  // WhereInput
  lines.push(
    `export const ${whereName}: z.ZodType<Prisma.${modelName}WhereInput> = z.lazy(() => ${whereObjectName});`,
    ''
  );

  // WhereInputObjectSchema
  lines.push(`const ${whereObjectName} = z.object({`);
  for (const field of scalarFields) {
    lines.push(`${indent(1)}${field.name}: ${shapeRefForWhere(modelName, field)},`);
  }
  for (const field of relationFields) {
    lines.push(`${indent(1)}${field.name}: ${relationWhereExpression(field, modelName, state)},`);
  }
  lines.push(`${indent(1)}AND: z.union([z.lazy(() => ${whereName}), z.lazy(() => ${whereName}).array()]),`);
  lines.push(`${indent(1)}OR: z.lazy(() => ${whereName}).array(),`);
  lines.push(`${indent(1)}NOT: z.union([z.lazy(() => ${whereName}), z.lazy(() => ${whereName}).array()]),`);
  lines.push('}).partial().strip();', '');

  const uniques = uniqueFields(model);
  if (uniques.length === 0) {
    lines.push(`export const ${whereUniqueName} = ${whereName} as z.ZodType<Prisma.${modelName}WhereUniqueInput>;`, '');
  } else {
    const combos = buildUniqueCombos(model, uniques);
    const branchSchemas: string[] = [];
    for (const combo of combos) {
      const comboLines: string[] = [];
      comboLines.push('z.intersection(');
      comboLines.push(`${indent(1)}z.object({`);
      for (const field of combo) {
        const expression = shapeRefForWhere(modelName, field);
        comboLines.push(`${indent(2)}${field.name}: ${expression},`);
      }
      comboLines.push(`${indent(1)}}),`);
      comboLines.push(`${indent(1)}${whereName}`);
      comboLines.push(')');
      branchSchemas.push(comboLines.join('\n'));
    }
    const unionExpression =
      branchSchemas.length === 1
        ? branchSchemas[0]
        : `z.union([\n${branchSchemas.map(branch => `${indent(1)}${branch}`).join(',\n')}\n])`;
    lines.push(
      `export const ${whereUniqueName} = ${unionExpression} as z.ZodType<Prisma.${modelName}WhereUniqueInput>;`,
      ''
    );
  }

  const relationListFields = relationFields.filter(f => f.isList);

  lines.push(`export const ${includeName} = z.object({`);
  for (const field of relationFields) {
    const targetMany = `${field.type}FindManyArgsSchema`;
    const targetUnique = `${field.type}FindUniqueArgsSchema`;
    const schema = field.isList ? targetMany : targetUnique;
    // return `includeRelationLazy(() => ${getSchema})`;

    // lines.push(`${indent(2)}${field.name}: ${relationIncludeExpression(modelName, field)},`);
    lines.push(`${indent(2)}${field.name}: z.union([z.boolean()/*, z.lazy(() => ${schema})*/]),`);
  }
  if (relationListFields.length > 0) {
    lines.push(`${indent(2)}_count: z.union([z.boolean(), z.object({`);
    lines.push(`${indent(3)}select: z.object({`);
    for (const field of relationListFields) {
      lines.push(
        `${indent(4)}${field.name}: z.union([z.boolean()/*, z.object({ where: ${
          field.type
        }WhereInputSchema.optional()}).strip()*/]).optional(),`
      );
    }
    lines.push(`${indent(3)}}).partial().strip() satisfies z.ZodType<Prisma.${modelName}CountOutputTypeSelect> `);
    lines.push(`${indent(2)}}).strip() satisfies z.ZodType<Prisma.${modelName}CountOutputTypeDefaultArgs>`);
    lines.push(`${indent(1)}])`);
  }
  lines.push(`}).partial().strip() satisfies z.ZodType<Prisma.${modelName}Include>;`, '');

  const relationScalarNames = relationFields.flatMap(f => f.relationFromFields ?? []);
  lines.push(
    `export const ${createInputName} = ${modelName}Schema.omit({ ${scalarFields
      .filter(field => field.isId || relationScalarNames.includes(field.name))
      .map(field => `${field.name}: true`)
      .join(', ')} }).extend({`
  );
  for (const field of relationFields) {
    const relatedCreateSchema = `${field.type}CreateInputSchema.omit({${modelName}: true}))`; // withOut ${modelName} create 会导致递归循环, 太复杂了, 暂时先不支持
    const createExpression = field.isList
      ? `z.union([z.lazy(() => ${relatedCreateSchema}), z.lazy(() => ${relatedCreateSchema}).array()])`
      : `z.lazy(() => ${relatedCreateSchema})`;

    const relatedWhereUniqueSchema = `${field.type}WhereUniqueInputSchema`;
    const connectExpression = field.isList
      ? `z.union([z.lazy(() => ${relatedWhereUniqueSchema}), z.lazy(() => ${relatedWhereUniqueSchema}).array()])`
      : `z.lazy(() => ${relatedWhereUniqueSchema})`;
    const baseExpression = `z.object({
    // ${indent(0)}create: ${createExpression}.optional(),
    ${indent(0)}connect: ${connectExpression}.optional(),
  ${indent(0)}}).strip()`;
    const expression = field.isList ? appendOptional(baseExpression) : maybeOptional(baseExpression, field);
    lines.push(`${indent(1)}${field.name}: ${expression},`);
  }
  lines.push(`});`, '');

  lines.push(`export const ${updateInputName} = ${createInputName}.partial();`, '');

  lines.push(`export const ${modelName}FindManyArgsSchema = z.object({`);
  lines.push(`${indent(1)}include: ${includeName}.default({}),`);
  lines.push(`${indent(1)}where: ${whereName}.optional(),`);
  lines.push(`${indent(1)}cursor: ${whereUniqueName}.optional(),`);
  lines.push(`${indent(1)}take: z.number().optional(),`);
  lines.push(`${indent(1)}skip: z.number().optional(),`);
  lines.push(`}).strip() satisfies z.ZodType<Prisma.${modelName}FindManyArgs>;`, '');

  lines.push(`export const ${modelName}FindUniqueArgsSchema = z.object({`);
  lines.push(`${indent(1)}include: ${includeName},`);
  lines.push(`${indent(1)}where: ${whereUniqueName},`);
  lines.push(`}).strip() satisfies z.ZodType<Prisma.${modelName}FindUniqueArgs>;`, '');

  lines.push(`export const ${modelName}CreateArgsSchema = z.object({`);
  lines.push(`${indent(1)}data: ${createInputName},`);
  lines.push(`}).strip() satisfies z.ZodType<Prisma.${modelName}CreateArgs>;`, '');

  lines.push(`export const ${modelName}UpdateArgsSchema = z.object({`);
  lines.push(`${indent(1)}data: ${updateInputName},`);
  lines.push(`${indent(1)}where: ${whereUniqueName},`);
  lines.push(`}).strip() satisfies z.ZodType<Prisma.${modelName}UpdateArgs>;`, '');

  lines.push(`export const ${modelName}DeleteArgsSchema = z.object({`);
  lines.push(`${indent(1)}include: ${includeName}.optional(),`);
  lines.push(`${indent(1)}where: ${whereUniqueName},`);
  lines.push(`}).strip() satisfies z.ZodType<Prisma.${modelName}DeleteArgs>;`, '');

  state.emittedModels.add(modelName);
}

generatorHandler({
  onManifest() {
    return {
      version: '1.0.0',
      prettyName: 'Prisma Zod Generator',
      defaultOutput: '../node_modules/@prisma/zod',
    };
  },

  async onGenerate(options: GeneratorOptions) {
    const outputDir = options.generator.output?.value ?? join(process.cwd(), 'node_modules/@prisma/zod');
    mkdirSync(outputDir, { recursive: true });

    enumDefinitions = new Map<string, string[]>();
    for (const enumDef of options.dmmf.datamodel.enums) {
      enumDefinitions.set(
        enumDef.name,
        enumDef.values.map(({ name }) => name)
      );
    }

    const state: GeneratorState = {
      lines: [],
      enumUsage: new Map<string, string[]>(),
      emittedModels: new Set<string>(),
    };

    for (const model of options.dmmf.datamodel.models) {
      pushModelSchemas(model, state);
    }

    const outputLines: string[] = [];
    outputLines.push(`import { z } from 'zod';`);
    outputLines.push(`import type { Prisma } from '@prisma/client';`, '');

    if (state.enumUsage.size > 0) {
      for (const [name, values] of state.enumUsage) {
        const literalValues = values.map(value => `'${value}'`).join(', ');
        outputLines.push(`const ${name}Schema = z.enum([${literalValues}] as const);`);
      }
      outputLines.push('');
    }

    outputLines.push(
      `type WhereRelationFilter<T> = {
  some?: T;
  none?: T;
  every?: T;
};`,
      ''
    );

    outputLines.push(
      `const whereRelationLazy = <T>(getSchema: () => z.ZodType<T>): z.ZodType<WhereRelationFilter<T>> => z.object({
      some: z.lazy(getSchema),
      none: z.lazy(getSchema),
      every: z.lazy(getSchema),
    })
    .partial()
    .strip();`,
      ''
    );

    outputLines.push(
      `const includeRelationLazy = <Schema extends z.ZodTypeAny>(
  getArgsSchema: () => Schema
): z.ZodType<boolean | z.infer<Schema>> =>
  z.union([z.boolean(), z.lazy(getArgsSchema)]) as z.ZodType<boolean | z.infer<Schema>>;`,
      ''
    );

    outputLines.push('// 自动生成，请勿手动修改', '');
    outputLines.push(...state.lines);

    writeFileSync(join(outputDir, 'index.ts'), outputLines.join('\n'));
  },
});
