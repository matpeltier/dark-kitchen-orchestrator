import ts from 'typescript';

import { WorkflowInputError } from './errors.js';
import type { ParsedWorkflow, WorkflowMeta, WorkflowMetaPhase } from './types.js';

/** Parse the literal metadata prefix and return an executable code-first workflow body. */
export function parseWorkflowScript(script: string): ParsedWorkflow {
  const sourceFile = ts.createSourceFile(
    'workflow.ts',
    script,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics =
    (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const diagnostic = diagnostics[0];
    throw new WorkflowInputError(
      `Script parse error: ${diagnostic ? diagnosticMessage(diagnostic) : 'unknown parse error'}`,
    );
  }

  const first = sourceFile.statements[0];
  if (
    !first ||
    !ts.isVariableStatement(first) ||
    !hasModifier(first, ts.SyntaxKind.ExportKeyword)
  ) {
    throw new WorkflowInputError(
      '`export const meta = { name, description, phases }` must be the FIRST statement in the script',
    );
  }
  if ((first.declarationList.flags & ts.NodeFlags.Const) === 0) {
    throw new WorkflowInputError('meta export must be `export const meta = ...`');
  }
  if (first.declarationList.declarations.length !== 1) {
    throw new WorkflowInputError('meta export must declare only `meta`');
  }

  const declaration = first.declarationList.declarations[0];
  if (!declaration || !ts.isIdentifier(declaration.name) || declaration.name.text !== 'meta') {
    throw new WorkflowInputError('meta export must declare `meta`');
  }
  if (!declaration.initializer) throw new WorkflowInputError('meta must have a literal value');

  const meta = evaluateLiteral(declaration.initializer, 'meta');
  validateMeta(meta);
  return { meta, body: buildExecutableBody(script, sourceFile, first) };
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== 'object') throw new WorkflowInputError('meta must be an object');
  const value = meta as WorkflowMeta;
  if (typeof value.name !== 'string' || !value.name.trim())
    throw new WorkflowInputError('meta.name must be a non-empty string');
  if (typeof value.description !== 'string' || !value.description.trim()) {
    throw new WorkflowInputError('meta.description must be a non-empty string');
  }
  if (value.title !== undefined && typeof value.title !== 'string')
    throw new WorkflowInputError('meta.title must be a string');
  if (value.whenToUse !== undefined && typeof value.whenToUse !== 'string') {
    throw new WorkflowInputError('meta.whenToUse must be a string');
  }
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new WorkflowInputError('meta.phases must be an array');
    for (const phase of value.phases) validatePhase(phase);
  }
}

function validatePhase(phase: unknown): asserts phase is WorkflowMetaPhase {
  if (!phase || typeof phase !== 'object')
    throw new WorkflowInputError('each meta phase must be an object');
  const value = phase as WorkflowMetaPhase;
  if (typeof value.title !== 'string' || !value.title.trim())
    throw new WorkflowInputError('each meta phase must have a title string');
  if (value.detail !== undefined && typeof value.detail !== 'string')
    throw new WorkflowInputError('meta phase detail must be a string');
}

function evaluateLiteral(node: ts.Expression, path: string): unknown {
  const value = unwrap(node);
  if (ts.isObjectLiteralExpression(value)) {
    const result: Record<string, unknown> = {};
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property))
        throw new WorkflowInputError(`spread not allowed in ${path}`);
      if (!ts.isPropertyAssignment(property))
        throw new WorkflowInputError(`only plain properties allowed in ${path}`);
      const key = propertyKey(property.name, path);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new WorkflowInputError(`reserved key name not allowed in ${path}: ${key}`);
      }
      result[key] = evaluateLiteral(property.initializer, `${path}.${key}`);
    }
    return result;
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.map((element, index) => {
      if (ts.isSpreadElement(element))
        throw new WorkflowInputError(`spread not allowed in ${path}`);
      return evaluateLiteral(element, `${path}[${index}]`);
    });
  }
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken) {
    const operand = unwrap(value.operand);
    if (ts.isNumericLiteral(operand)) return -Number(operand.text);
  }
  throw new WorkflowInputError(
    `meta must be a pure literal: non-literal node type in ${path}: ${ts.SyntaxKind[value.kind]}`,
  );
}

function propertyKey(name: ts.PropertyName, path: string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  if (ts.isComputedPropertyName(name))
    throw new WorkflowInputError(`computed keys not allowed in ${path}`);
  throw new WorkflowInputError(`unsupported key type in ${path}: ${ts.SyntaxKind[name.kind]}`);
}

function unwrap(node: ts.Expression): ts.Expression {
  let value = node;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isNonNullExpression(value)
  ) {
    value = value.expression;
  }
  return value;
}

function buildExecutableBody(
  script: string,
  sourceFile: ts.SourceFile,
  metaStatement: ts.Statement,
): string {
  let body = script.slice(0, metaStatement.getStart(sourceFile));
  let cursor = metaStatement.end;
  let importIndex = 0;
  for (const statement of sourceFile.statements.slice(1)) {
    const start = statement.getStart(sourceFile);
    body += script.slice(cursor, start);
    body += transformStatement(script, sourceFile, statement, importIndex);
    if (ts.isImportDeclaration(statement) && !isTypeOnlyImport(statement)) importIndex++;
    cursor = statement.end;
  }
  return body + script.slice(cursor);
}

function transformStatement(
  script: string,
  sourceFile: ts.SourceFile,
  statement: ts.Statement,
  importIndex: number,
): string {
  if (ts.isImportDeclaration(statement)) return transformImport(statement, importIndex);
  if (ts.isExportDeclaration(statement)) {
    if (statement.isTypeOnly) return '';
    return statement.moduleSpecifier
      ? `await __workflow_import(${JSON.stringify(moduleText(statement.moduleSpecifier))});`
      : '';
  }
  if (ts.isExportAssignment(statement)) {
    return `const __workflow_default_export = ${script.slice(statement.expression.getStart(sourceFile), statement.expression.end)};`;
  }
  if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
    const text = script
      .slice(statement.getStart(sourceFile), statement.end)
      .replace(/^export\s+/, '');
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword) && anonymousDeclaration(statement)) {
      return `const __workflow_default_export = ${text.replace(/^default\s+/, '')};`;
    }
    return text.replace(/^default\s+/, '');
  }
  return script.slice(statement.getStart(sourceFile), statement.end);
}

function transformImport(statement: ts.ImportDeclaration, importIndex: number): string {
  const specifier = moduleText(statement.moduleSpecifier);
  const clause = statement.importClause;
  if (!clause) return `await __workflow_import(${JSON.stringify(specifier)});`;
  if (clause.isTypeOnly) return '';
  const tempName = `__workflow_import_${importIndex}`;
  const bindings: string[] = [];
  if (clause.name) bindings.push(`const ${clause.name.text} = ${tempName}.default;`);
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings))
      bindings.push(`const ${clause.namedBindings.name.text} = ${tempName};`);
    else {
      for (const element of clause.namedBindings.elements) {
        if (!element.isTypeOnly)
          bindings.push(
            `const ${element.name.text} = ${tempName}[${JSON.stringify(element.propertyName?.text ?? element.name.text)}];`,
          );
      }
    }
  }
  return bindings.length === 0
    ? ''
    : [
        `const ${tempName} = await __workflow_import(${JSON.stringify(specifier)});`,
        ...bindings,
      ].join('\n');
}

function moduleText(node: ts.Expression): string {
  return ts.isStringLiteral(node) ? node.text : '';
}

function isTypeOnlyImport(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  return Boolean(
    !clause.name &&
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.every((element) => element.isTypeOnly),
  );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(
    ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind),
  );
}

function anonymousDeclaration(node: ts.Node): boolean {
  return (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name === undefined;
}

function diagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}
