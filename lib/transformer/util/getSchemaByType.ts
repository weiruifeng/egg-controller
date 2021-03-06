import * as ts from 'typescript';
import { SchemaObject, SchemasObject, ReferenceObject } from 'openapi3-ts';
import { getValue } from '../../util';
import { getComment } from './getComment';
import { isArrayType } from './isArrayType';
import { getHashCode } from './getHashCode';

export interface TypeCache {
  typeName: string;
  schemaName: string;
  type: ts.Type;
  hashCode?: string;
}

export interface GetSchemaConfig {
  schemaObjects: SchemasObject;
  typeCache: TypeCache[];
  typeChecker: ts.TypeChecker;
  extendClass?: boolean;
}

export function getSchemaByType(type: ts.Type, config: GetSchemaConfig): SchemaObject {
  const { typeChecker } = config;

  // 接口层拆掉 Promise (Promise 对应 orm 中定义 lazy 情况)
  if (getValue(() => type.symbol.escapedName) === 'Promise') {
    type = (type as any).typeArguments[0];
  }

  const defaultSchemaObject: SchemaObject = {};
  const comment = getComment((type as any).type || type);
  if (comment) {
    defaultSchemaObject.description = comment;
  }
  const objectFlags = (type as ts.ObjectType).objectFlags;
  if (isArrayType(type)) {
    return {
      ...defaultSchemaObject,
      type: 'array',
      items: getSchemaByType((type as any).typeArguments[0], config),
    };
  } else if (type.flags & ts.TypeFlags.Boolean) {
    // boolean is kind of union
    return {
      ...defaultSchemaObject,
      type: 'boolean',
    };
  } else if (type.isUnion && type.isUnion()) {
    const unionType: ts.UnionType = type as any;
    if (unionType.types.every(t => !!(t.flags & ts.TypeFlags.EnumLiteral))) {
      return {
        ...defaultSchemaObject,
        type: 'string',
        enum: unionType.types.map((t: ts.LiteralType) => {
          return t.value;
        }),
      };
    } else {
      return {
        ...defaultSchemaObject,
        type: 'object',
        oneOf: unionType.types.map(t => getSchemaByType(t, config)),
      };
    }
  } else if (type.isIntersection && type.isIntersection()) {
    const intersectionType: ts.IntersectionType = type as any;
    return {
      ...defaultSchemaObject,
      type: 'object',
      allOf: intersectionType.types.map(t => getSchemaByType(t, config)),
    };
  } else if (type.isClassOrInterface()) {
    switch (type.symbol.escapedName) {
      case 'Date':
        return {
          ...defaultSchemaObject,
          type: 'string',
          format: 'date',
        };
      case 'Object':
        return {
          ...defaultSchemaObject,
          type: 'any',
        };

      default:
        return config.extendClass
          ? extendClass(type, defaultSchemaObject, config)
          : addRefTypeSchema(type, config);
    }
  } else if (objectFlags & ts.ObjectFlags.Anonymous) {
    return extendClass(type as ts.InterfaceType, defaultSchemaObject, config);
  }
  return {
    ...defaultSchemaObject,
    type: typeChecker.typeToString(type),
  };
}

function addRefTypeSchema(type: ts.InterfaceType, config: GetSchemaConfig): ReferenceObject {
  const { schemaObjects, typeCache } = config;

  const cache = typeCache.find(c => c.type === type);
  if (cache) {
    return {
      $ref: `#/components/schemas/${cache.schemaName}`,
    };
  }

  const typeName = `${type.symbol.escapedName}`;

  let schemaName = typeName;
  if (schemaObjects[typeName]) {
    let i = 1;
    while (schemaObjects[`${typeName}_${i}`]) {
      i++;
    }
    schemaName = `${typeName}_${i}`;
  }

  const cacheData: TypeCache = { typeName, schemaName, type };
  typeCache.push(cacheData);

  const schema = getSchemaByType(type, { ...config, extendClass: true });
  const hashCode = getHashCode(schema);

  const cacheIndex = typeCache.findIndex(c => c.hashCode === hashCode && c.typeName === typeName);
  if (cacheIndex >= 0) {
    typeCache.splice(
      typeCache.findIndex(c => c.schemaName === schemaName),
      1
    );
    schemaName = cache.schemaName;
  } else {
    cacheData.hashCode = hashCode;
    schemaObjects[schemaName] = schema;
  }
  return {
    $ref: `#/components/schemas/${schemaName}`,
  };
}

function extendClass(
  type: ts.InterfaceType,
  defaultSchemaObject: Partial<SchemaObject>,
  config: GetSchemaConfig
) {
  config = { ...config, extendClass: false };

  const schema: SchemaObject = {
    ...defaultSchemaObject,
    type: 'object',
    properties: {},
    required: [],
  };
  const indexType = type.getNumberIndexType() || type.getStringIndexType();
  if (indexType) {
    schema.additionalProperties = getSchemaByType(indexType, config);
  }
  type
    .getProperties()
    .filter(
      symbol =>
        !symbol.valueDeclaration ||
        !symbol.valueDeclaration.modifiers ||
        !symbol.valueDeclaration.modifiers.some(m => {
          return [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(m.kind);
        })
    )
    .forEach(symbol => {
      const escapedName = `${symbol.escapedName}`;
      function setProp(value: any) {
        if (!getValue(() => (symbol.valueDeclaration as any).questionToken)) {
          schema.required.push(escapedName);
        }
        schema.properties[escapedName] = {
          description: getComment(symbol),
          ...value,
        };
      }

      if (
        symbol.valueDeclaration &&
        (ts.isMethodDeclaration(symbol.valueDeclaration) ||
          ts.isMethodSignature(symbol.valueDeclaration) ||
          ts.isArrowFunction(symbol.valueDeclaration))
      ) {
        // 函数忽略
        return;
      }

      const targetType = getValue(() => (symbol as any).type || (symbol as any).target.type);
      if (targetType) {
        setProp(getSchemaByType(targetType, config));
      } else if (symbol.valueDeclaration) {
        const propType = config.typeChecker.getTypeAtLocation(symbol.valueDeclaration);

        if (getValue(() => propType.symbol.escapedName) === 'Function') {
          return;
        }

        // check arrow function prop.
        const arrowType = getValue(() => propType.symbol.valueDeclaration);
        if (arrowType && ts.isArrowFunction(arrowType)) {
          return;
        }

        setProp(getSchemaByType(propType, config));
      } else {
        setProp({
          type: 'any',
        });
      }
    });
  return schema;
}
