import { adoptStandardLibraries, sharedLibraryAugmentations } from "./source-admission.js";
import { parentPort } from "node:worker_threads";
import {bindGlobalNominals,globalNominals} from "./global-nominals.js";
import { captureGlobalTypes } from "./global-types.js";
import { versionRegistry } from "./versions.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { dataShape, functionArtifact, ShapeError } from "./type-contracts.js";
import type { CompileRequest, CompileResponse, EmittedModule, GeneratorName } from "./transport.js";
import type { BindingDescription } from "../compiler/artifacts.js";
import type { CompilationDiagnostic } from "../compiler/types.js";
const hash = versionRegistry();
const sourceCache = new Map<string, { text: string; source: ts.SourceFile }>();
const coreRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)))+path.sep;
function compile(request: CompileRequest): CompileResponse {
  const captured = new Map<string, string>(), resolutions = new Map<string, Map<string, string>>();
  const entry = fileURLToPath(request.entry);
  let original: string;
  if (request.text !== undefined) original = request.text; else original = readFileSync(entry, "utf8");
  captured.set(entry, original);
  const parsed = ts.createSourceFile(entry, original, ts.ScriptTarget.ES2022, true);
  const names = new Map<string, ts.Identifier>();
  const collect = (name: ts.BindingName) => { if (ts.isIdentifier(name)) names.set(name.text, name); else for (const element of name.elements) if (ts.isBindingElement(element)) collect(element.name); };
  for (const statement of parsed.statements) {
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) collect(declaration.name);
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name && ts.isIdentifier(statement.name) && !(ts.isModuleDeclaration(statement) && statement.flags & ts.NodeFlags.GlobalAugmentation)) names.set(statement.name.text, statement.name);
    else if (ts.isImportDeclaration(statement) && statement.importClause) { const clause=statement.importClause; if(clause.name)names.set(clause.name.text,clause.name); if(clause.namedBindings) { if(ts.isNamespaceImport(clause.namedBindings)) names.set(clause.namedBindings.name.text,clause.namedBindings.name);else for(const element of clause.namedBindings.elements)names.set(element.name.text,element.name); } }
  }
  const scopeVars=(node:ts.Node):void=>{if(ts.isFunctionLike(node)||ts.isClassLike(node)||ts.isModuleDeclaration(node))return;if(ts.isVariableDeclarationList(node)&&!(node.flags&ts.NodeFlags.BlockScoped))for(const declaration of node.declarations)collect(declaration.name);ts.forEachChild(node,scopeVars);};scopeVars(parsed);
  const prelude = request.statePrelude;
  const exported = new Set<string>();
  for (const statement of parsed.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const item of statement.exportClause.elements) exported.add(item.name.text);
    if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) && !ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        const gather = (name: ts.BindingName): void => { if (ts.isIdentifier(name)) exported.add(name.text); else for (const item of name.elements) if (ts.isBindingElement(item)) gather(item.name); }; gather(declaration.name);
      } else if ("name" in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) exported.add((statement.name as ts.Identifier).text);
    }
  }
  const additional = [...names.keys()].filter(name => !exported.has(name));
  const adopted = prelude + original + (additional.length ? `\nexport { ${additional.join(",")} };\n` : "\nexport {};\n");
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, skipLibCheck: true, declaration: true, esModuleInterop: true, types: [], lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], moduleDetection: ts.ModuleDetectionKind.Force };
  const host = ts.createCompilerHost(options);
  const baseRead = host.readFile.bind(host), baseExists = host.fileExists.bind(host), baseDirectory=host.directoryExists!.bind(host);
  const standardLibraries=adoptStandardLibraries(options,file=>request.libraryFiles[file]??baseRead(file));
  const libraryFiles:Record<string,string>={...standardLibraries,...Object.fromEntries(Object.entries(request.libraryFiles).filter(([file])=>file!==entry&&file.startsWith(coreRoot)&&!Object.hasOwn(request.declarationOrigins,file)))};
  const trustedCore=new Set(Object.keys(libraryFiles).filter(file=>file.startsWith(coreRoot)));
  host.directoryExists=(directory)=>Object.keys(request.declarationFiles).some(file=>file.startsWith(directory+path.sep))||baseDirectory(directory);
  host.readFile = (file) => {
    if(file===entry){captured.set(file,original);return adopted;}
    const known=captured.get(file)??request.declarationFiles[file]??libraryFiles[file];
    const text=known??baseRead(file);if(text!==undefined){captured.set(file,text);if(file.endsWith('.d.ts')&&trustedCore.has(file))libraryFiles[file]=text;}return text;
  };
  host.fileExists=(file)=>file===entry||request.declarationFiles[file]!==undefined||libraryFiles[file]!==undefined||baseExists(file);
  function resolveActual(name:string,containingFile:string):ts.ResolvedModuleFull|undefined {
    const fixed=name.replace(/\.js$/,'.d.ts');let resolved:ts.ResolvedModuleFull|undefined;
    if(request.declarationFiles[fixed]!==undefined)resolved={resolvedFileName:fixed,extension:ts.Extension.Dts,isExternalLibraryImport:false};
    else if(/^@bitagent\/core(?:\/(host|state|compiler|node))?$/.test(name)){const suffix=name.split('/')[2]??'index';resolved={resolvedFileName:path.join(coreRoot,suffix+'.d.ts'),extension:ts.Extension.Dts,isExternalLibraryImport:true};}
    else resolved=ts.resolveModuleName(name,containingFile,options,host).resolvedModule;
    if(resolved){let file=resolved.resolvedFileName;if(request.declarationFiles[file]===undefined&&libraryFiles[file]===undefined)try{file=realpathSync(file);}catch{};resolved={...resolved,resolvedFileName:file};let table=resolutions.get(containingFile);if(!table){table=new Map();resolutions.set(containingFile,table);}table.set(name,file);}return resolved;
  }
  const graph=new Map<string,Map<string,string>>();
  function captureGraph(file:string,owned=false):void {
    const authoritative=owned&&file.startsWith(coreRoot)&&file!==entry,newAuthority=authoritative&&!trustedCore.has(file);
    if(authoritative)trustedCore.add(file);
    if(graph.has(file)){if(newAuthority)for(const target of graph.get(file)!.values())captureGraph(target,true);return;}const edges=new Map<string,string>();graph.set(file,edges);
    const text=file===entry?original:host.readFile(file);if(text===undefined)return;
    const parsed=ts.preProcessFile(text,true,true);
    for(const imported of parsed.importedFiles){const resolved=resolveActual(imported.fileName,file);if(resolved){edges.set(imported.fileName,resolved.resolvedFileName);captureGraph(resolved.resolvedFileName,authoritative||/^@bitagent\/core(?:\/(host|state|compiler|node))?$/.test(imported.fileName));}}
    for(const referenced of parsed.referencedFiles){const target=path.resolve(path.dirname(file),referenced.fileName);edges.set('reference:'+referenced.fileName,target);captureGraph(target,authoritative);}
  }
  captureGraph(entry);
  // Availability retains old versions; only current definition roots contribute type context.
  for(const file of [...request.activeDeclarations,...Object.keys(request.ambientDeclarations)])captureGraph(file);
  const globalDeclarations=[...graph.keys()].filter(file=>{if(file!==entry&&(trustedCore.has(file)||Object.hasOwn(standardLibraries,file)))return false;const source=ts.createSourceFile(file,captured.get(file)??"",ts.ScriptTarget.ES2022,true);if(/\.d\.[cm]?ts$/.test(file)&&!ts.isExternalModule(source))return true;let augmented=false;const visit=(node:ts.Node):void=>{if(ts.isModuleDeclaration(node)&&(node.flags&ts.NodeFlags.GlobalAugmentation||ts.isStringLiteral(node.name)))augmented=true;ts.forEachChild(node,visit);};visit(source);return augmented;});
  const image=(file:string):readonly[string,string|undefined]=>{const origin=request.declarationOrigins[file];return origin?[origin.url,origin.text]:[pathToFileURL(file).href,captured.get(file)];};
  const fingerprints=new Map<string,string>();
  for(const file of graph.keys()){
    const reachable=new Set<string>();const visit=(file:string):void=>{if(reachable.has(file))return;reachable.add(file);for(const target of graph.get(file)?.values()??[])visit(target);};visit(file);globalDeclarations.forEach(visit);
    const records=new Map<string,readonly[readonly[string,string|undefined],readonly string[]]>();
    // Adopted text owns spelling; canonical destinations own equivalent resolution edges.
    for(const source of reachable){const content=image(source),edges=[...new Set([...(graph.get(source)?.values()??[])].map(target=>image(target)[0]))].sort();records.set(JSON.stringify([content,edges]),[content,edges]);}
    fingerprints.set(file,JSON.stringify([...records.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))));
  }
  const nominals=globalNominals(globalDeclarations,captured,request.declarationOrigins,graph);
  const reused=new Map<string,(typeof request.cachedModules)[number]>();
  for(const item of request.cachedModules){const file=fileURLToPath(item.module.url);if(file!==entry&&fingerprints.get(file)===item.module.fingerprint)reused.set(file,item);}
  const declarationReuse=new Map(request.cachedDeclarations.filter(item=>fingerprints.get(item.source)===item.fingerprint).map(item=>[item.source,item]));
  host.resolveModuleNames=(moduleNames,containingFile)=>moduleNames.map(name=>{
    const resolved=resolveActual(name,containingFile);if(!resolved)return undefined;
    const item=reused.get(resolved.resolvedFileName)??declarationReuse.get(resolved.resolvedFileName);return item?{resolvedFileName:item.file,extension:ts.Extension.Dts,isExternalLibraryImport:false}:resolved;
  });
  const boundSources=new Map<string,ReturnType<typeof bindGlobalNominals>>(),emittedNominals=new Set<string>();
  const sourcePosition=(file:string,position:number):number=>boundSources.get(file)?.originalPosition(position)??position;
  host.getSourceFile = (file, languageVersion) => {
    const original=host.readFile(file);if(original===undefined)return undefined;
    let binding=boundSources.get(file);
    if(!binding&&globalDeclarations.includes(file)){binding=bindGlobalNominals(ts.createSourceFile(file,original,languageVersion,true),nominals.descriptors,request.globalNominals,emittedNominals);boundSources.set(file,binding);}
    const text=binding?.text??original,old=sourceCache.get(file);
    const source=old?.text===text?old.source:ts.createSourceFile(file,text,languageVersion,true);
    source.impliedNodeFormat=ts.ModuleKind.ESNext;sourceCache.set(file,{text,source});return source;
  };
  parentPort!.postMessage({phase:"checking",id:request.id,workerTime:performance.now()});
  const roots=[entry,...Object.keys(request.ambientDeclarations),...[...graph.keys()].filter(file=>file!==entry&&!reused.has(file)&&!file.endsWith('.d.ts'))];
  const program = ts.createProgram(roots, options, host), checker=program.getTypeChecker(), source=program.getSourceFile(entry)!;
  const diagnostics: CompilationDiagnostic[] = [];
  function span(file:ts.SourceFile|undefined,start:number|undefined,length:number|undefined){
    if(!file||start===undefined)return {};
    const offset=file.fileName===entry?prelude.length:0,position=sourcePosition(file.fileName,start)-offset;
    if(position<0||file.fileName===entry&&position>original.length)return {};
    const width=sourcePosition(file.fileName,start+(length??0))-offset-position;
    return {span:{url:pathToFileURL(file.fileName).href,start:position,length:Math.max(0,file.fileName===entry?Math.min(width,original.length-position):width)}};
  }
  function diagnostic(d: ts.Diagnostic): CompilationDiagnostic {return {phase:d.code<2000?"syntax":"type",severity:d.category===ts.DiagnosticCategory.Error?"error":d.category===ts.DiagnosticCategory.Warning?"warning":"message",code:`ts:${d.code}`,message:ts.flattenDiagnosticMessageText(d.messageText,"\n"),...span(d.file,d.start,d.length),related:(d.relatedInformation??[]).map(r=>({message:ts.flattenDiagnosticMessageText(r.messageText,"\n"),...span(r.file,r.start,r.length)}))};}
  diagnostics.push(...ts.getPreEmitDiagnostics(program).map(diagnostic));
  const libraryAugmentations = sharedLibraryAugmentations(program, libraryFiles);
  for (const name of libraryAugmentations) diagnostics.push({phase:"source",severity:"error",code:"core:shared-library-augmentation",message:`Augmenting adopted readonly library symbol '${name.text}' cannot preserve earlier complete types`,...span(name.getSourceFile(),name.getStart(),name.getWidth()),related:[]});
  if (libraryAugmentations.length) {
    parentPort!.postMessage({phase:"completed",id:request.id,workerTime:performance.now()});
    return {id:request.id,entry:request.entry,diagnostics,libraryFiles,globalNominals:[],globalTypeContext:{fingerprint:"",declaration:"",ambientDeclarations:{}},sources:[],modules:[],definitions:[],declaration:"",declarationFile:entry,declarationFingerprints:{},declarations:{},declarationImages:{},resolutions:{}};
  }
  for(const file of program.getSourceFiles())if(!file.isDeclarationFile){
    const dynamic=(node:ts.CallExpression):void=>{diagnostics.push({phase:"source",severity:"error",code:"core:dynamic-import",message:"Dynamic imports cannot preserve the fixed synchronous module graph",...span(file,node.getStart(file),node.getWidth(file)),related:[]});};
    const scanImports=(node:ts.Node):void=>{if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)dynamic(node);ts.forEachChild(node,scanImports);};
    const scan=(node:ts.Node):void=>{if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)dynamic(node);if(ts.isFunctionLike(node)){ts.forEachChild(node,scanImports);return;}if(ts.isAwaitExpression(node)||ts.isForOfStatement(node)&&node.awaitModifier)diagnostics.push({phase:"source",severity:"error",code:"core:async-module",message:"Top-level await cannot execute through the synchronous input boundary",...span(file,node.getStart(file),node.getWidth(file)),related:[]});ts.forEachChild(node,scan);};scan(file);
  }
  for(const [file,edges]of graph)if([...edges.values()].includes(entry))diagnostics.push({phase:"source",severity:"error",code:"core:entry-dependency",message:"Persistent modules cannot depend on a re-executed command entry",related:[]});
  const definitions: BindingDescription[]=[];
  const scopedSymbols=new Map(checker.getSymbolsInScope(source,ts.SymbolFlags.Value|ts.SymbolFlags.Type|ts.SymbolFlags.Namespace|ts.SymbolFlags.Alias).map(symbol=>[symbol.name,symbol]));
  const entrySymbols=new Map([...names].sort((a,b)=>a[1].pos-b[1].pos).flatMap(([name])=>{const symbol=scopedSymbols.get(name);return symbol?[[name,checker.getExportSymbolOfSymbol(symbol)] as const]:[];}));
  for(const [name,symbol] of entrySymbols) {
    const target=symbol.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(symbol):symbol;
    const typeOnly=symbol.declarations?.some(d=>ts.isImportClause(d)&&d.isTypeOnly||ts.isImportSpecifier(d)&&(d.isTypeOnly||d.parent.parent.isTypeOnly)||ts.isNamespaceImport(d)&&d.parent.isTypeOnly)??false;
    const value=!typeOnly&&!!(target.flags&ts.SymbolFlags.Value),type=typeOnly||!!(target.flags&ts.SymbolFlags.Type);
    const declaration=symbol.valueDeclaration??symbol.declarations?.[0];
    const mutable=!!declaration&&ts.isVariableDeclaration(declaration)&&!(declaration.parent.flags&ts.NodeFlags.Const);
    definitions.push({name,kind:value?(type?"value-type":"value"):"type",mutable,display:checker.typeToString(!value&&type?checker.getDeclaredTypeOfSymbol(target):checker.getTypeOfSymbolAtLocation(symbol,declaration??source),undefined,ts.TypeFormatFlags.NoTruncation),origins:(symbol.declarations??[]).filter(d=>d.getSourceFile()===source).map(d=>({url:request.entry,start:Math.max(0,sourcePosition(source.fileName,d.getStart(source))-prelude.length),length:Math.max(0,sourcePosition(source.fileName,d.end)-sourcePosition(source.fileName,d.getStart(source)))}))});
  }
  const emitted=new Map<string,{code:string;declaration:string}>();
  const externalNames=new Map(request.externalDefinitions.map(d=>[d.name,d]));
  function namespaceOrigin(expression:ts.Expression,seen=new Set<ts.Symbol>()):boolean {if(ts.isParenthesizedExpression(expression)||ts.isAsExpression(expression)||ts.isNonNullExpression(expression))return namespaceOrigin(expression.expression,seen);const symbol=checker.getSymbolAtLocation(expression);if(!symbol||seen.has(symbol))return false;seen.add(symbol);return (symbol.declarations??[]).some(d=>ts.isNamespaceImport(d)||ts.isVariableDeclaration(d)&&!!(d.parent.flags&ts.NodeFlags.Const)&&!!d.initializer&&namespaceOrigin(d.initializer,seen));}
  function coreOrigin(symbol:ts.Symbol|undefined,seen=new Set<ts.Symbol>()):GeneratorName|undefined {if(!symbol)return;symbol=checker.getExportSymbolOfSymbol(symbol);if(seen.has(symbol))return;seen.add(symbol);for(const declaration of symbol.declarations??[]){const previous=request.cachedModules.find(item=>item.file===declaration.getSourceFile().fileName);const cached=previous&&Object.hasOwn(previous.module.generatorAliases,symbol.name)?previous.module.generatorAliases[symbol.name]:undefined;if(cached)return cached;}if(symbol.flags&ts.SymbolFlags.Alias)return coreOrigin(checker.getAliasedSymbol(symbol),seen);for(const d of symbol.declarations??[]){if(ts.isFunctionDeclaration(d)&&d.name&&["contract","defineFunction","tool"].includes(d.name.text)&&d.getSourceFile().fileName===path.join(coreRoot,"runtime",({contract:"contracts",defineFunction:"functions",tool:"tools"} as Record<string,string>)[d.name.text]+".d.ts"))return d.name.text as GeneratorName;if(d.getSourceFile()===source&&sourcePosition(source.fileName,d.getStart(source))<prelude.length){const name=request.externalDefinitions.find(item=>item.name===symbol!.name)?.generator;if(name)return name;}if(ts.isVariableDeclaration(d)&&d.initializer){const origin=coreName(d.initializer,seen);if(origin)return origin;}}}
  function coreName(expression:ts.Expression,seen=new Set<ts.Symbol>()):GeneratorName|undefined {if(ts.isParenthesizedExpression(expression)||ts.isAsExpression(expression)||ts.isNonNullExpression(expression))return coreName(expression.expression,seen);if(ts.isPropertyAccessExpression(expression)&&!namespaceOrigin(expression.expression))return;return coreOrigin(checker.getSymbolAtLocation(expression),seen);}
  const helperNames=new Map<string,{environment:string;generated:string;capture:string;display:string;acquire:string}>();
  const transformer:ts.TransformerFactory<ts.SourceFile>=(context)=>{
    const f=context.factory;
    const json=(value:unknown):ts.Expression=>{if(value===null)return f.createNull();if(typeof value==='string')return f.createStringLiteral(value);if(typeof value==='number')return f.createNumericLiteral(value);if(typeof value==='boolean')return value?f.createTrue():f.createFalse();if(Array.isArray(value))return f.createArrayLiteralExpression(value.map(json));return f.createObjectLiteralExpression(Object.entries(value as object).map(([k,v])=>f.createPropertyAssignment(f.createComputedPropertyName(f.createStringLiteral(k)),json(v))));};
    return(sf)=>{
      const isEntry=sf.fileName===entry;
      const occupied=new Set<string>();const collectIdentifiers=(node:ts.Node):void=>{if(ts.isIdentifier(node))occupied.add(node.text);ts.forEachChild(node,collectIdentifiers);};collectIdentifiers(sf);
      let suffix="";while(["__bitEnvironment","__bitGenerated","__bitCapture","__bitDisplay","__bitAcquire"].some(name=>occupied.has(name+suffix)||new RegExp("\\b"+name+suffix+"\\b").test(sf.text)))suffix+="_";
      const helpers={environment:"__bitEnvironment"+suffix,generated:"__bitGenerated"+suffix,capture:"__bitCapture"+suffix,display:"__bitDisplay"+suffix,acquire:"__bitAcquire"+suffix};helperNames.set(sf.fileName,helpers);
      const ext=(node:ts.Identifier)=>{const symbol=checker.getSymbolAtLocation(node);return isEntry&&externalNames.has(node.text)&&symbol?.declarations?.some(d=>d.getSourceFile()===source&&sourcePosition(source.fileName,d.getStart(source))<prelude.length)?externalNames.get(node.text):undefined;};
      const get=(id:string)=>f.createPropertyAccessExpression(f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier(helpers.environment),'binding'),undefined,[f.createStringLiteral(id)]),'value');
      const visit:ts.Visitor=(node)=>{
        if(ts.isCallExpression(node)){const name=coreName(node.expression);if(name){try{const typeNode=node.typeArguments?.[0];if(!typeNode)throw new ShapeError(node,'Concrete type argument is required');const type=checker.getTypeFromTypeNode(typeNode);let artifact:unknown;if(name==='contract')artifact=dataShape(checker,type,node,true);else if(name==='defineFunction')artifact=functionArtifact(checker,type,node);else {const result=checker.getTypeAtLocation(node) as ts.TypeReference;const args=checker.getTypeArguments(result);const parameters=dataShape(checker,type,node),output=dataShape(checker,args[1]!,node,true);const signature=checker.getTypeAtLocation(node.arguments[1]!).getCallSignatures()[0];const description=signature?ts.displayPartsToString(signature.getDocumentationComment(checker)):'';artifact={parameters,result:output,...(description?{description}:{})};}const target=ts.visitNode(node.expression,visit) as ts.Expression;const receiver=ts.isPropertyAccessExpression(node.expression)?ts.visitNode(node.expression.expression,visit) as ts.Expression:f.createVoidZero();const guarded=f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier(helpers.generated),"guard"),undefined,[f.createStringLiteral(name),target,json(artifact),receiver]);const args=node.arguments.map(a=>ts.visitNode(a,visit) as ts.Expression);return ts.isCallChain(node)?f.updateCallChain(node,guarded,node.questionDotToken,undefined,args):f.updateCallExpression(node,guarded,undefined,args);}catch(error){if(!(error instanceof ShapeError))throw error;diagnostics.push({phase:'contract',severity:'error',code:'core:contract-shape',message:error.message,...span(sf,error.node.getStart(sf),error.node.getWidth(sf)),related:[]});}}}
        if(ts.isShorthandPropertyAssignment(node)){const external=ext(node.name);if(external)return f.createPropertyAssignment(node.name,node.objectAssignmentInitializer?f.createAssignment(get(external.id),ts.visitNode(node.objectAssignmentInitializer,visit) as ts.Expression):get(external.id));}
        if(ts.isIdentifier(node)&&ext(node)&&!(ts.isPropertyAccessExpression(node.parent)&&node.parent.name===node)&&!(ts.isPropertyAssignment(node.parent)&&node.parent.name===node)&&!("name" in node.parent && node.parent.name === node && !ts.isShorthandPropertyAssignment(node.parent)) )return get(ext(node)!.id);
        return ts.visitEachChild(node,visit,context);
      };
      let transformed=ts.visitEachChild(sf,visit,context);
      if(isEntry){const statements:ts.Statement[]=[];for(const statement of transformed.statements){
        if(sourcePosition(sf.fileName,statement.getStart(sf))<prelude.length || ts.isExportDeclaration(statement)&&sourcePosition(sf.fileName,statement.getStart(sf))>=prelude.length+original.length)continue;
        statements.push(statement);
      }
        const capture=definitions.filter(d=>d.kind!=='type').map(d=>f.createPropertyAssignment(f.createComputedPropertyName(f.createStringLiteral(d.name)),f.createObjectLiteralExpression([f.createMethodDeclaration(undefined,undefined,'read',undefined,undefined,[],undefined,f.createBlock([f.createReturnStatement(ts.setOriginalNode(f.createIdentifier(d.name), (entrySymbols.get(d.name)?.declarations?.[0] as ts.NamedDeclaration)?.name ?? f.createIdentifier(d.name)))],true)),...(d.mutable?[f.createMethodDeclaration(undefined,undefined,'write',undefined,undefined,[f.createParameterDeclaration(undefined,undefined,'value')],undefined,f.createBlock([f.createExpressionStatement(f.createAssignment(ts.setOriginalNode(f.createIdentifier(d.name), (entrySymbols.get(d.name)?.declarations?.[0] as ts.NamedDeclaration)?.name ?? f.createIdentifier(d.name)),f.createIdentifier('value')))],true))]:[])])));
        statements.unshift(f.createVariableStatement(undefined,f.createVariableDeclarationList([f.createVariableDeclaration(helpers.display)],ts.NodeFlags.Let)));
        statements.unshift(f.createExpressionStatement(f.createCallExpression(f.createIdentifier(helpers.capture),undefined,[f.createObjectLiteralExpression([f.createPropertyAssignment("values",f.createObjectLiteralExpression(capture)),f.createMethodDeclaration(undefined,undefined,"result",undefined,undefined,[],undefined,f.createBlock([f.createReturnStatement(f.createIdentifier(helpers.display))],true))])])));
        let index=statements.length-1;while(index>=0&&ts.isEmptyStatement(statements[index]!))index--;if(index>=0&&ts.isExpressionStatement(statements[index]!)){const statement=statements[index] as ts.ExpressionStatement;statements[index]=f.createExpressionStatement(f.createAssignment(f.createIdentifier(helpers.display),statement.expression));}
        const published:ts.Statement[]=[];for(const statement of statements){published.push(statement);const initialized:string[]=[];const declared=(name:ts.BindingName):void=>{if(ts.isIdentifier(name))initialized.push(name.text);else for(const element of name.elements)if(!ts.isOmittedExpression(element))declared(element.name);};if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)declared(declaration.name);else if((ts.isClassDeclaration(statement)||ts.isEnumDeclaration(statement)||ts.isFunctionDeclaration(statement))&&statement.name)initialized.push(statement.name.text);if(initialized.length)published.push(f.createExpressionStatement(f.createCallExpression(f.createIdentifier(helpers.capture),undefined,[f.createObjectLiteralExpression([f.createPropertyAssignment("initialized",json(initialized))])])));}statements.splice(0,statements.length,...published);
        statements.push(f.createExportDeclaration(undefined,false,f.createNamedExports([f.createExportSpecifier(false,undefined,helpers.display)])));
        transformed=f.updateSourceFile(transformed,statements);
      }
      return transformed;
    };
  };
  const globalTypes=captureGlobalTypes(program,checker,JSON.stringify([...new Set(globalDeclarations.map(file=>fingerprints.get(file)))].sort()),globalDeclarations,captured);
  program.emit(undefined,(file,text,_bom,_error,files)=>{const originalFile=files?.[0]?.fileName;if(!originalFile)return;let record=emitted.get(originalFile);if(!record){record={code:'',declaration:''};emitted.set(originalFile,record);}if(file.endsWith('.d.ts')||file.endsWith('.d.mts'))record.declaration=text;else if(/\.[cm]?js$/.test(file))record.code=text;},undefined,false,{before:[transformer],afterDeclarations:[globalTypes.transform]});
  // Inferred declaration types can introduce imports absent from the input syntax.
  // Resolve them against the same adopted host before fixing their versioned paths.
  for (const [file, record] of emitted) if (record.declaration) {
    const declaration = ts.createSourceFile(file + '.d.ts', record.declaration, ts.ScriptTarget.ES2022, true);
    const visit = (node: ts.Node): void => {
      let name: ts.StringLiteral | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) name = node.moduleSpecifier;
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) name = node.argument.literal;
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) name = node.moduleReference.expression;
      if (name) resolveActual(name.text, file);
      ts.forEachChild(node, visit);
    };
    visit(declaration);
  }
  if(!emitted.get(entry)?.code)diagnostics.push({phase:"source",severity:"error",code:"core:entry",message:"The entry has no synchronous execution artifact",related:[]});
  const modules:EmittedModule[]=[...reused.values()].map(item=>item.module);
  for(const [file,record] of emitted){if(!record.code)continue;
    const dependencies:Record<string,string>={},declarationDependencies:Record<string,string>={};
    const js=ts.createSourceFile(file+'.mjs',record.code,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
    const runtimeNames=new Set(js.statements.filter((n):n is ts.ImportDeclaration|ts.ExportDeclaration=>ts.isImportDeclaration(n)||ts.isExportDeclaration(n)).map(n=>n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier)?n.moduleSpecifier.text:'').filter(Boolean));
    for(const [name,target] of resolutions.get(file)??[]){
      if(!request.declarationFiles[target]&&captured.has(target))declarationDependencies[pathToFileURL(target).href]=hash(captured.get(target)!);
      if(!runtimeNames.has(name))continue;
      if(name.startsWith('@bitagent/core'))dependencies[name]=name;
      else if(!target.endsWith('.d.ts')&&!target.endsWith('.d.mts'))dependencies[name]=pathToFileURL(target).href;
      else diagnostics.push({phase:'source',severity:'error',code:'core:module',message:`External runtime module is not supported: ${name}`,related:[]});
    }
    const externalIDs=new Set<string>();
    if(file===entry){const scan=(node:ts.Node)=>{if(sourcePosition(source.fileName,node.getStart(source))>=prelude.length&&ts.isIdentifier(node)&&externalNames.has(node.text)){const symbol=checker.getSymbolAtLocation(node);if(symbol?.declarations?.some(d=>d.getSourceFile()===source&&sourcePosition(source.fileName,d.getStart(source))<prelude.length))externalIDs.add(externalNames.get(node.text)!.id);}ts.forEachChild(node,scan);};scan(source);}

    const cjs=record.code;
    const exports=checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(file)!)!).filter(s=>{const target=s.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(s):s;return !!(target.flags&ts.SymbolFlags.Value);}).map(s=>s.name);
    const generatorAliases=Object.create(null) as Record<string,GeneratorName>;for(const symbol of checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(file)!)!)){const name=coreOrigin(symbol);if(name){generatorAliases[symbol.name]=name;const target=symbol.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(symbol):symbol;generatorAliases[target.name]=name;}}
    modules.push({generatorAliases,url:pathToFileURL(file).href,fingerprint:fingerprints.get(file)??JSON.stringify([file,captured.get(file)]),code:cjs,exports,dependencies,externalIDs:[...externalIDs],declarationDependencies,helpers:helperNames.get(file)!});
  }
  parentPort!.postMessage({phase:"completed",id:request.id,workerTime:performance.now()});
  const declarations=Object.fromEntries([...emitted].filter(([,record])=>record.declaration).map(([file,record])=>[file,record.declaration]));
  const declarationImages=Object.fromEntries([...captured].filter(([file])=>file.endsWith('.d.ts')||file.endsWith('.d.mts')).map(([file,text])=>[file,!Object.hasOwn(libraryFiles,file)&&program.getSourceFile(file)?globalTypes.localizeDeclaration(program.getSourceFile(file)!):text]));
  return {globalNominals:nominals.descriptors,globalTypeContext:globalTypes.snapshot(),id:request.id,entry:request.entry,diagnostics,declarations,declarationImages,libraryFiles,declarationFingerprints:Object.fromEntries([...fingerprints].filter(([file])=>/\.d\.[cm]?ts$/.test(file)&&!Object.hasOwn(libraryFiles,file))),resolutions:Object.fromEntries([...resolutions].map(([file,table])=>[file,Object.fromEntries(table)])),sources:[...captured].filter(([file])=>file===entry||emitted.has(file)||libraryFiles[file]===undefined).map(([file,text])=>({url:pathToFileURL(file).href,text,version:hash(text)})),modules,definitions,declarationFile:entry,declaration:declarations[entry]??''};
}
parentPort!.on("message",(request:CompileRequest)=>{try{parentPort!.postMessage({result:compile(request)});}catch(error){parentPort!.postMessage({error: error instanceof Error?{message:error.message,stack:error.stack,name:error.name,properties:Object.fromEntries(Object.keys(error).map(key=>[key,(error as unknown as Record<string,unknown>)[key]]))}: {message:String(error)}});}});
