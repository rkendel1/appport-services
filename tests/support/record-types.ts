/**
 * Reads StoredRecords (stored-records.ts) with the TypeScript compiler: for each
 * collection, every property of its record type, whether it may be absent or null, and
 * the FeltDB field type its TypeScript type implies.
 */
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface RecordField {
  readonly name: string;
  /** text | integer-or-number | boolean | json */
  readonly kind: 'text' | 'numeric' | 'boolean' | 'json';
  readonly optional: boolean;
}

const SOURCE = fileURLToPath(new URL('../../../tests/support/stored-records.ts', import.meta.url));

export function recordTypes(): Map<string, RecordField[]> {
  const program = ts.createProgram([SOURCE], { strict: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(SOURCE);
  if (!file) throw new Error(`cannot read ${SOURCE}`);
  const records = file.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === 'StoredRecords');
  if (!records) throw new Error('StoredRecords not found');
  const out = new Map<string, RecordField[]>();
  for (const member of records.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue;
    const collection = (member.name as ts.Identifier).text;
    const type = checker.getTypeFromTypeNode(member.type);
    const fields: RecordField[] = [];
    for (const property of checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration ?? file);
      const parts = propertyType.isUnion() ? propertyType.types : [propertyType];
      const present = parts.filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 || present.length !== parts.length;
      const kinds = new Set(present.map((t) =>
        t.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral | ts.TypeFlags.TemplateLiteral) ? 'text'
          : t.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral) ? 'numeric'
            : t.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral) ? 'boolean'
              : 'json'));
      fields.push({ name: property.name, kind: kinds.size === 1 ? [...kinds][0] as RecordField['kind'] : 'json', optional });
    }
    out.set(collection, fields);
  }
  return out;
}
