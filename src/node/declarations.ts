import path from "node:path";
import {globalContextModule} from "./global-types.js";
import {fileURLToPath,pathToFileURL} from "node:url";
import type {CompileResponse,CachedModule,CachedDeclaration} from "./transport.js";
import type {SourceOrigin} from "../compiler/artifacts.js";

function decode(value:string):string {
 return value.replace(/\\(u\{[0-9a-f]+\}|u[0-9a-f]{4}|x[0-9a-f]{2}|\r?\n|.)/gi,(_whole,escaped:string)=>{
  if(escaped.startsWith("u{"))return String.fromCodePoint(parseInt(escaped.slice(2,-1),16));
  if(escaped.startsWith("u")||escaped.startsWith("x"))return String.fromCharCode(parseInt(escaped.slice(1),16));
  return ({b:"\b",f:"\f",n:"\n",r:"\r",t:"\t",v:"\v","0":"\0","\n":"","\r\n":""} as Record<string,string>)[escaped]??escaped;
 });
}
/** Only adopted compiler declarations and resolution tables define a fixed type graph. */
export function fixedDeclarations(response:CompileResponse, previous:Readonly<Record<string,string>>, previousOrigins:Readonly<Record<string,SourceOrigin>>, versions:ReadonlyMap<string,string>, application:string, generation:number, cached:readonly CachedModule[],cachedDeclarations:readonly CachedDeclaration[],identity:(value:string)=>string) {
 const files:Record<string,string>={...previous,...response.libraryFiles};
 const paths=new Map<string,string>();
 for(const item of cached){Object.assign(files,item.files);if(response.modules.some(module=>module.url===item.module.url&&module.fingerprint===item.module.fingerprint))paths.set(fileURLToPath(item.module.url),item.file);}
 for(const item of cachedDeclarations){Object.assign(files,item.files);if(response.declarationFingerprints[item.source]===item.fingerprint)paths.set(item.source,item.file);}
 const root=fileURLToPath(response.entry);
 for(const file of Object.keys(response.declarations)){
  const version=file===root?"input-"+generation:versions.get(pathToFileURL(file).href)!;
  paths.set(file,path.join(path.dirname(file),".__bit_types",application,version,path.basename(file).replace(/\.[cm]?tsx?$/,".d.ts")));
 }
 // Local declaration-only dependencies have their own content-derived adopted identity.
 for(const [file,text]of Object.entries(response.declarationImages))if(!Object.hasOwn(response.libraryFiles,file)&&!Object.hasOwn(previous,file)&&!paths.has(file)){
  // Its graph is fixed by the source adoption; this name is private to this compilation.
  paths.set(file,path.join(path.dirname(file),".__bit_types",application,"declaration-"+identity(response.declarationFingerprints[file]??JSON.stringify([file,text])),path.basename(file)));
 }
 const globalFile=path.join(path.dirname(root),".__bit_types",application,"global-"+identity(response.globalTypeContext.fingerprint),"global.d.ts");
 const rewrite=(text:string,file:string)=>text.replace(/(from\s+|import\s*\(\s*|import\s*)(["'])([^"']+)\2/g,(whole,prefix:string,_quote:string,name:string)=>{const decoded=decode(name);const target=response.resolutions[file]?.[decoded]??(path.isAbsolute(decoded)?paths.has(decoded)?decoded:[decoded.replace(/\.js$/,".ts"),decoded.replace(/\.js$/,".d.ts"),decoded.replace(/\.mjs$/,".mts"),decoded.replace(/\.mjs$/,".d.mts"),decoded.replace(/\.cjs$/,".cts"),decoded.replace(/\.cjs$/,".d.cts")].find(candidate=>paths.has(candidate)):undefined);const adopted=decoded===globalContextModule?globalFile:target&&paths.get(target);return adopted?prefix+JSON.stringify(adopted.replace(/\.d\.ts$/,".js")):whole;});
 files[globalFile]=rewrite(response.globalTypeContext.declaration,globalFile);
 const ambientDeclarations:Record<string,string>={},ambientOrigins:Record<string,SourceOrigin>={};
 for(const [source,text]of Object.entries(response.globalTypeContext.ambientDeclarations)){const origin=previousOrigins[source]??response.sources.find(record=>record.url===pathToFileURL(source).href);if(!origin)throw new Error("Ambient declaration has no adopted origin: "+source);const destination=path.join(path.dirname(root),".__bit_types",application,"ambient-"+identity(JSON.stringify([origin.url,origin.text])),path.basename(source).replace(/\.[cm]?tsx?$/,".d.ts"));ambientDeclarations[destination]=rewrite(text,source);ambientOrigins[destination]={url:origin.url,text:origin.text};}
 for(const [file,text]of Object.entries({...response.declarationImages,...response.declarations})){
  const destination=paths.get(file);if(!destination)continue;
  files[destination]=rewrite(text,file);
 }
 const sourceOrigins:Record<string,SourceOrigin>={...previousOrigins};
 for(const [source,destination]of paths){const prior=previousOrigins[source],record=response.sources.find(record=>record.url===pathToFileURL(source).href);if(prior)sourceOrigins[destination]=prior;else if(record)sourceOrigins[destination]={url:record.url,text:record.text};else throw new Error("Fixed declaration has no adopted source origin: "+source);}
 const file=paths.get(root)!;
 return {file,files,paths,sourceOrigins,ambientDeclarations,ambientOrigins,globalFile,declaration:files[file]!};
}
