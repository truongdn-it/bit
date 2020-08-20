import { TypescriptAspect } from './typescript.aspect';
import { MainRuntime } from '@teambit/cli';
import { TypescriptCompiler } from './typescript.compiler';
import { SchemaAspect } from '@teambit/schema';
import type { SchemaMain } from '@teambit/schema';
import { TypeScriptParser } from './typescript.parser';
import { TypeScriptCompilerOptions } from './compiler-options';
import { Compiler } from '@teambit/compiler';
import { Logger, LoggerMain, LoggerAspect } from '@teambit/logger';

export class TypescriptMain {
  constructor(private logger: Logger) {}
  /**
   * create a new compiler.
   */
  createCompiler(options: TypeScriptCompilerOptions): Compiler {
    return new TypescriptCompiler(this.logger, options);
  }

  resolveTypeFile() {}

  /**
   * add the default package json properties to the component
   * :TODO @gilad why do we need this DSL? can't I just get the args here.
   */
  getPackageJsonProps() {
    return {
      main: 'dist/{main}.js',
      types: '{main}.ts',
    };
  }

  static runtime = MainRuntime;
  static dependencies = [SchemaAspect, LoggerAspect];

  static async provider([schema, loggerExt]: [SchemaMain, LoggerMain]) {
    schema.registerParser(new TypeScriptParser());
    const logger = loggerExt.createLogger(TypescriptAspect.id);
    return new TypescriptMain(logger);
  }
}

TypescriptAspect.addRuntime(TypescriptMain);
