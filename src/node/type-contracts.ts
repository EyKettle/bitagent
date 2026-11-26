import ts from "typescript";
import type { DataShape } from "../runtime/contracts.js";
import type { FunctionArtifact } from "../runtime/functions.js";
export class ShapeError extends Error { constructor(readonly node: ts.Node, message: string) { super(message); } }
export function dataShape(checker: ts.TypeChecker, type: ts.Type, node: ts.Node, unit = false, optional = false): DataShape {
  const definitions: Record<string, DataShape> = {}, seen = new Map<ts.Type, string>();
  function shape(t: ts.Type, where: ts.Node, allowUnit = false, omitUndefined = false): DataShape {
    if(omitUndefined&&t.isUnion()){const present=t.types.filter(member=>!(member.flags&ts.TypeFlags.Undefined));if(present.length===1)return shape(present[0]!,where,allowUnit);return {kind:"union",items:present.map(member=>shape(member,where,allowUnit))};}
    const f = t.flags;
    if (f & ts.TypeFlags.Void) { if (allowUnit) return { kind: "unit" }; throw new ShapeError(where, "void is only supported as the entire result"); }
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.TypeParameter | ts.TypeFlags.Undefined | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.BigIntLike)) throw new ShapeError(where, "Type is not a concrete data shape");
    if (t.isUnion()) {
      if (t.types.some((member) => member.flags & ts.TypeFlags.Void)) throw new ShapeError(where, "A union cannot contain void");
      return { kind: "union", items: t.types.map((member) => shape(member, where)) };
    }
    if (f & ts.TypeFlags.StringLiteral) return { kind: "literal", value: (t as ts.StringLiteralType).value };
    if (f & ts.TypeFlags.NumberLiteral) return { kind: "literal", value: (t as ts.NumberLiteralType).value };
    if (f & ts.TypeFlags.BooleanLiteral) return { kind: "literal", value: checker.typeToString(t) === "true" };
    if (f & ts.TypeFlags.String) return { kind: "string" };
    if (f & ts.TypeFlags.Number) return { kind: "number" };
    if (f & ts.TypeFlags.Boolean) return { kind: "boolean" };
    if (f & ts.TypeFlags.Null) return { kind: "null" };
    if (!(f & ts.TypeFlags.Object) && !t.isIntersection()) throw new ShapeError(where, "Type is not data");
    if (t.getCallSignatures().length || t.getConstructSignatures().length) throw new ShapeError(where, "Executable or identity-dependent types are not data");
    const previous = seen.get(t); if (previous !== undefined) return { kind: "ref", ref: previous };
    const id = `type${seen.size}`; seen.set(t, id);
    if (checker.isTupleType(t)) {
      const tuple = t as ts.TypeReference;
      const target = tuple.target as ts.TupleType;
      if (target.elementFlags.slice(0,-1).some(flag => flag & ts.ElementFlags.Rest)) throw new ShapeError(where, "A suffix after a repeated tuple element has no exact schema projection");
      if (target.elementFlags.some(flag => flag & ts.ElementFlags.Variadic)) throw new ShapeError(where, "Tuple expansion requires a concrete element shape");
      const items = checker.getTypeArguments(tuple).map((member,index) => {
        if (target.elementFlags[index]! & ts.ElementFlags.Optional && member.isUnion()) {
          const present = member.types.filter(t => !(t.flags & ts.TypeFlags.Undefined));
          return present.length === 1 ? shape(present[0]!,where) : {kind:"union" as const,items:present.map(t=>shape(t,where))};
        }
        return shape(member,where);
      });
      definitions[id]={ kind: "tuple", items, tupleFlags: target.elementFlags.map(flag => flag & ts.ElementFlags.Rest ? "rest" : flag & ts.ElementFlags.Optional ? "optional" : "required") }; return {kind:"ref",ref:id};
    }
    if (checker.isArrayType(t) || t.symbol?.name === "ReadonlyArray") {definitions[id]={ kind: "array", items: [shape(checker.getTypeArguments(t as ts.TypeReference)[0]!, where)] };return {kind:"ref",ref:id};}
    if (t.symbol?.declarations?.some((declaration) => ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))) throw new ShapeError(where, "Class instances are not data");
    const properties: Record<string, { shape: DataShape; optional: boolean; description?: string }> = {};
    for (const property of checker.getPropertiesOfType(t)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? where;
      if (property.name.startsWith("__@") || property.declarations?.some((d) => ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d) || ts.isMethodSignature(d))) throw new ShapeError(declaration, "Executable properties are not data");
      let propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
      const optional = !!(property.flags & ts.SymbolFlags.Optional);
      if (optional && propertyType.isUnion()) propertyType = checker.getNonNullableType(propertyType) === propertyType ? propertyType : checker.getTypeOfSymbolAtLocation(property, declaration);
      // Optional absence is distinct from an explicit undefined value.
      const members = propertyType.isUnion() && optional ? propertyType.types.filter((member) => !(member.flags & ts.TypeFlags.Undefined)) : undefined;
      const propertyShape = members ? members.length === 1 ? shape(members[0]!, declaration) : { kind: "union" as const, items: members.map((m) => shape(m, declaration)) } : shape(propertyType, declaration);
      const description = ts.displayPartsToString(property.getDocumentationComment(checker));
      Object.defineProperty(properties, property.name, { value: { shape: propertyShape, optional, ...(description ? { description } : {}) }, enumerable: true });
    }
    const stringIndex = checker.getIndexTypeOfType(t, ts.IndexKind.String), numberIndex = checker.getIndexTypeOfType(t, ts.IndexKind.Number);
    if (numberIndex && !stringIndex) throw new ShapeError(where, "Numeric object indexes are not representable");
    const result: DataShape = { kind: "object", properties, ...(stringIndex ? { additional: shape(stringIndex, where) } : {}) };
    definitions[id] = result;
    return { kind: "ref", ref: id };
  }
  const result = shape(type, node, unit, optional);
  return { ...result, ...(Object.keys(definitions).length ? { definitions } : {}) };
}
export function functionArtifact(checker: ts.TypeChecker, type: ts.Type, node: ts.Node): FunctionArtifact {
  const signatures = type.getCallSignatures();
  if (signatures.length !== 1 || signatures[0]!.typeParameters?.length) throw new ShapeError(node, "Function contract requires one concrete signature");
  const signature = signatures[0]!;
  return { parameters: signature.parameters.map((parameter) => {
    const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? node;
    if (ts.isParameter(declaration) && declaration.dotDotDotToken) throw new ShapeError(declaration, "Rest business parameters are not supported");
    let t = checker.getTypeOfSymbolAtLocation(parameter, declaration);
    const optional = !!(parameter.flags & ts.SymbolFlags.Optional) || ts.isParameter(declaration) && !!(declaration.questionToken || declaration.initializer);
    if (optional && t.isUnion()) { const members=t.types.filter(m=>!(m.flags&ts.TypeFlags.Undefined)); if(members.length===1)t=members[0]!; }
    return { name: parameter.name, optional, shape: dataShape(checker, t, declaration, false, optional) };
  }), result: dataShape(checker, signature.getReturnType(), node, true) };
}
