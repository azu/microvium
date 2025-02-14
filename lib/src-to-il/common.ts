import { noCase } from 'no-case';
import { CompileError, unexpected } from '../utils';
import * as B from './supported-babel-types';

// Tells us where we are in the source file
export interface SourceCursor {
  filename: string;
  node: B.Node;
}

// This is called before we investigate a node during analysis or IL output. It
// records the current AST node being compiled so that if subsequent errors are
// generated then we know where the error occurred
export function visitingNode(cur: SourceCursor, node: B.Node) {
  cur.node = node;
}

export function compileError(cur: SourceCursor, message: string): never {
  if (!cur.node.loc) return unexpected();
  throw new CompileError(`${
    message
  }\n      at ${cur.node.type} (${
    cur.filename
  }:${
    cur.node.loc.start.line
  }:${
    cur.node.loc.start.column
  })`);
}

export function featureNotSupported(cur: SourceCursor, message: string): never {
  return compileError(cur, message);
}

export function compileErrorIfReachable(cur: SourceCursor, value: never): never {
  const v = value as any;
  const type = typeof v === 'object' && v !== null ? v.type : undefined;
  const message = type ? `Not supported: ${noCase(type)}` : 'Not supported';
  compileError(cur, message);
}

/**
 * An error resulting from the internal compiler code, not a user mistake
 */
export function internalCompileError(cur: SourceCursor, message: string): never {
  if (!cur.node.loc) return unexpected();
  throw new Error(`Internal compile error: ${
    message
  }\n      at ${cur.node.type} (${
    cur.filename
  }:${
    cur.node.loc.start.line
  }:${
    cur.node.loc.start.column
  })`);
}