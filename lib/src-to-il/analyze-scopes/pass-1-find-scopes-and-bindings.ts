import { notUndefined, unexpected, assertUnreachable, hardAssert, isNameString, uniqueNameInSet } from "../../utils";
import { visitingNode, compileError, featureNotSupported, SourceCursor } from "../common";
import { traverseChildren } from "../traverse-ast";
import { Scope, Reference, Binding, FunctionScope, ScopeNode, ModuleScope, BlockScope, BindingNode } from "./analysis-model";
import * as B from '../supported-babel-types';
import { AnalysisState } from "./analysis-state";

export function pass1_findScopesAndBindings({
  file,
  cur,
  importBindings,
  model,
}: AnalysisState) {
  /*
  (See analyzeScopes for a description of this pass)

  This function is implemented as a single tree-traversal pass using
  `traverseAST`. It maintains a `scopeStack` to keep track of what lexical scope
  the cursor is in. When it encounters a new scope AST node (e.g. function or
  block scope), it will push the scope onto the stack and enumerate the local
  bindings. When it encounters a reference node (e.g. a variable or parameter
  reference), it iterates up the stack to find the binding or falls back to
  creating a free variable (`freeVariableNames`).

  A `this` reference can either resolve to a local argument (if using the
  caller-passed this) or to the `this` value in the parent (if using lexical
  this, as in arrow functions). The `this` value in the parent may again resolve
  to a parameter or to _its_ parent's `this` value, etc.
  */

  const { references, bindings, scopes } = model;

  const scopeStack: Scope[] = [];
  const currentScope = () => notUndefined(scopeStack[scopeStack.length - 1]);

  const ilFunctionNames = new Set<string>();

  traverse(file.program);

  function traverse(node_: B.Node, context?: unknown) {
    const node = node_ as B.Program | B.SupportedStatement | B.SupportedExpression;
    visitingNode(cur, node);
    switch (node.type) {
      // Scope nodes
      case 'Program': return traverseModuleScope(node);
      case 'FunctionDeclaration': return traverseFunctionDeclarationScope(node);
      case 'ArrowFunctionExpression': return traverseFunctionExpressionScope(cur, node);
      case 'FunctionExpression': return traverseFunctionExpressionScope(cur, node);
      case 'BlockStatement': return traverseBlockScope(node);
      case 'ForStatement': return traverseForStatement(node);

      // Reference nodes
      case 'Identifier': return createVariableReference(node);
      case 'ThisExpression': return createVariableReference(node);

      // Mutating nodes
      case 'AssignmentExpression': return handleAssignmentExpression(node);
      case 'UpdateExpression': return handleUpdateExpression(node);

      default:
        traverseChildren(cur, node, traverse);
    }

    function traverseModuleScope(node: B.Program) {
      const scope = pushModuleScope(node);
      model.moduleScope = scope;

      const body = node.body;

      findImportsAndExports(node);

      // Find variables in the root scope and nested blocks
      findVarDeclarations(body);

      // Lexical variables are also found upfront because nested functions can
      // reference variables that are declared further down than the nested
      // function (TDZ). (But `findLexicalVariables` isn't recursive)
      findBlockScopeDeclarations(body);

      // Iterate through the function/program body to find variable usage
      traverseChildren(cur, node, traverse);

      popScope(scope);
    }

    function traverseFunctionDeclarationScope(node: B.FunctionDeclaration) {
      const scope = pushFunctionScope(node, true);
      scope.funcName = node.id?.name;

      createParameterBindings(scope, node.params);

      const body = node.body.body;
      findVarDeclarations(body);

      // Note: we don't do `findBlockScopeDeclarations` because the traversal
      // will find these declarations (let and const) in the function body which
      // is a a "block"

      // Iterate through the body to find variable usage
      traverseChildren(cur, node, traverse);

      popScope(scope);
    }

    function traverseFunctionExpressionScope(cur: SourceCursor, node: B.ArrowFunctionExpression | B.FunctionExpression) {
      const hasThisBinding = node.type === 'FunctionExpression';
      const scope = pushFunctionScope(node, hasThisBinding);
      createParameterBindings(scope, node.params);
      const body = node.body;

      if (node.type === 'FunctionExpression' && node.id) {
        // Named function expressions are not supported yet, since they would
        // introduce recursion possibilities that are not as simple to solve.
        // E.g.
        //
        //     const foo = function bar() { bar() };
        //     const bar = 42; // A different `bar`
        //
        return featureNotSupported(cur, 'Named function expressions');
      }

      if (body.type === 'BlockStatement') {
        const statements = body.body;
        findVarDeclarations(statements);

        // Note: we don't do `findBlockScopeDeclarations` because the traversal
        // will find these declarations (let and const) in the function body which
        // is a a "block"
      } else {
        /* Note: Arrow functions with expression bodies do not have any hoisted variables */
      }

      traverse(body);

      popScope(scope);
    }

    function traverseBlockScope(node: B.BlockStatement, sameLifetimeAsParent?: boolean) {
      // Creates a lexical scope
      const scope = pushBlockScope(node, sameLifetimeAsParent ?? true);
      // Here we don't need to populate the hoisted variables because they're
      // already populated by the containing function/program
      findBlockScopeDeclarations(node.body);
      for (const statement of node.body) {
        traverse(statement);
      }
      popScope(scope);
    }

    function traverseForStatement(node: B.ForStatement) {
      // The outer block is for the loop variables (e.g. `i`). If these are part
      // of a closure scope, this scope is created during the loop
      // initialization and given the initial values of the loop variables, and
      // then cloned between each loop iteration so that each loop iteration
      // "sees" the value of the variables from its iteration.
      const sameLifetimeAsParent = false;

      // Create a lexical scope for any variables introduced by the `for`
      const scope = pushBlockScope(node, sameLifetimeAsParent);

      if (node.init && node.init.type === 'VariableDeclaration') {
        bindLexicalDeclaration(node.init);
      }

      // Note: this also needs to traverse the `node.init` and `node.update`
      traverseChildren(cur, node, (node, context) => {
        if (node.type === 'BlockStatement') {
          // The loop body also exists once per loop iteration, so in some sense
          // it has the same lifetime as its parent (the loop outer block) but the
          // loop outer block is cloned on each iteration while the inner block is
          // not, which is why we mark it as different lifetimes. This means that
          // the variables declared in the loop body get a fresh TDZ value at the
          // beginning of each iteration rather than inheriting the cloned value
          // from the previous iteration.
          const bodyHasSameLifetimeAsParent = false;
          traverseBlockScope(node, bodyHasSameLifetimeAsParent);
        } else {
          traverse(node, context);
        }
      });

      popScope(scope);
    }

    function handleAssignmentExpression(node: B.AssignmentExpression) {
      traverseChildren(cur, node, traverse);

      handleMutationToVariable(node.left);
    }

    function handleUpdateExpression(node: B.UpdateExpression) {
      traverseChildren(cur, node, traverse);
      handleMutationToVariable(node.argument);
    }

    function handleMutationToVariable(expr: B.LVal | B.Expression) {
      // This is basically to determine which slots need to be mutable. The main
      // reason for this is to decide which parameters need to be copied into
      // local slots.
      if (expr.type === 'Identifier') {
        const reference = references.get(expr) ?? unexpected();
        const resolvesTo = reference.resolvesTo;
        if (resolvesTo.type === 'Binding') {
          if (resolvesTo.binding.isDeclaredReadonly) {
            compileError(cur, `Cannot assign to variable "${reference.name}" because it is declared readonly`);
          }
          resolvesTo.binding.isWrittenTo = true;
        }
      }
    }

    function createVariableReference(node: B.Identifier | B.ThisExpression) {
      const name = node.type === 'Identifier' ? node.name : '#this';
      const binding = node.type === 'Identifier'
        ? findBinding(name)
        : findThisBinding();

      if (binding) {
        const currentFunction = containingFunction(currentScope());
        const bindingFunction = containingFunction(binding.scope);
        const isInLocalFunction = bindingFunction === currentFunction;

        // Note that this includes block-scoped variables for blocks at the root level
        const mustBeClosureAllocated = !isInLocalFunction;
        if (mustBeClosureAllocated) {
          if (!currentFunction) unexpected();
          binding.isAccessedByNestedFunction = true;
          const isGlobal = binding.scope.type === 'ModuleScope';
          // Note: Global variables can be accessed without a closure scope
          if (!isGlobal) {
            markClosureChain(currentFunction, bindingFunction);
          }
        }
        const reference: Reference = {
          name: name,
          resolvesTo: { type: 'Binding', binding },
          isInLocalFunction,
          nearestScope: currentScope(),
          access: undefined as any // Will be populated in a later phase
        };
        references.set(node, reference);
        currentScope().references.push(reference);
      } else { // Binding not found
        if (node.type === 'ThisExpression') {
          // The `this` expression must evaluate to undefined
          const reference: Reference = {
            name: name,
            resolvesTo: { type: 'RootLevelThis' },
            isInLocalFunction: false,
            nearestScope: currentScope(),
            access: undefined as any, // Populated in phase 2
          };
          references.set(node, reference);
          currentScope().references.push(reference);
        } else {
          // Free variable reference
          const reference: Reference = {
            name,
            isInLocalFunction: false,
            nearestScope: currentScope(),
            resolvesTo: { type: 'FreeVariable', name },
            access: undefined as any, // Populated in phase 2
          };
          model.freeVariables.add(name);
          references.set(node, reference);
          currentScope().references.push(reference);
        }
      }
    }

    function findBinding(name: string): Binding | undefined {
      // Loop through the scope stack starting from the inner-most and working
      // out until we find it
      for (let i = scopeStack.length - 1; i >= 0; i--) {
        const scope = scopeStack[i];
        const binding = scope.bindings[name];
        if (binding) {
          return binding;
        }
      }
      // If a binding is not found, it's a free variable (a reference to a global)
      return undefined;
    }

    function findThisBinding(): Binding | undefined {
      // Loop through the scope stack starting from the inner-most and working
      // out until we find it
      for (let i = scopeStack.length - 1; i >= 0; i--) {
        const scope = scopeStack[i];
        const binding = scope.type === 'FunctionScope' && scope.thisBinding;
        if (binding) {
          return binding;
        }
      }
      // If a binding is not found, it's a free variable (a reference to a global)
      return undefined;
    }

    // Mark all the functions from referencingFunction (inclusive) to
    // bindingFunction (exclusive) as needing to be closures (because they
    // access their outer scope). Note that "undefined" here refers to the
    // module scope.
    function markClosureChain(
      referencingFunction: FunctionScope | undefined,
      bindingFunction: FunctionScope | undefined
    ) {
      let cursor = referencingFunction;
      while (cursor !== bindingFunction) {
        if (!cursor) unexpected();
        cursor.functionIsClosure = true;
        cursor = containingFunction(cursor.parent);
      }
    }

    // Returns the innermost function containing or equal to the given scope,
    // or undefined if the given scope is not within a function (e.g. it's at
    // the model level)
    function containingFunction(scope: Scope): FunctionScope | undefined {
      let current: Scope | undefined = scope;
      while (current !== undefined && current.type !== 'FunctionScope')
        current = current.parent;
      return current;
    }
  }

  /**
   * This function looks for var declarations for a variable scope (program- or
   * function-level) and creates bindings for them in the current scope.
   *
   * Note: this function does NOT find exported var declarations (e.g. `export
   * var x;`).
   */
  function findVarDeclarations(body: B.Statement[]) {
    for (const statement of body) {
      traverse(statement);
    }

    function traverse(node_: B.Node) {
      const node = node_ as B.SupportedNode;
      switch (node.type) {
        case 'ExportNamedDeclaration':
        case 'ImportDeclaration':
          break; // Handled separately
        case 'VariableDeclaration': {
          // This function is only looking for hoisted variables
          if (node.kind === 'var') {
            bindVarDeclaration(node, false);
          }
          break;
        }

        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
          break;

        default:
          // We don't want to recurse into nested functions accidentally
          if (B.isFunctionNode(node)) assertUnreachable(node);

          traverseChildren(cur, node, traverse);
          break;
      }
    }
  }

  // This function looks for block-scoped declarations (let, const, and function
  // declarations). It does not look recursively because these kinds of
  // declarations are not hoisted out of nested blocks.
  function findBlockScopeDeclarations(statements: B.Statement[]) {
    for (const statement of statements) {
      if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ImportDeclaration')
        continue; // Handled separately

      visitingNode(cur, statement);
      if (statement.type === 'VariableDeclaration') {
        bindLexicalDeclaration(statement);
      } else if (statement.type === 'FunctionDeclaration') {
        // Function declarations are "hoisted" but not to the function scope but
        // rather to the top of the block
        if (statement.id) {
          bindFunctionDeclaration(statement, false);
        }
      }
    }
  }

  function bindLexicalDeclaration(statement: B.VariableDeclaration) {
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      hardAssert(statement.kind === 'const' || statement.kind === 'let');

      for (const declaration of statement.declarations) {
        const id = declaration.id;
        if (id.type !== 'Identifier') {
          visitingNode(cur, id);
          return compileError(cur, 'Syntax not supported')
        }
        const name = id.name;

        const binding = createBindingAndSelfReference(name, statement.kind, declaration, false);
        currentScope().lexicalDeclarations.push(binding);
      }
    }
  }

  function bindFunctionDeclaration(node: B.FunctionDeclaration, isExported: boolean) {
    const id = node.id ?? unexpected();
    const name = id.name;
    const binding = createBindingAndSelfReference(name, 'function', node, isExported);
    currentScope().nestedFunctionDeclarations.push({
      func: node,
      binding,
    })
    return binding;
  }

  function findImportsAndExports(program: B.Program) {
    for (const statement of program.body) {
      visitingNode(cur, statement);

      switch (statement.type) {
        case 'ExportNamedDeclaration': bindNamedExports(statement); break;
        case 'ImportDeclaration': createImportBindings(statement); break;
      }
    }
  }

  function createImportBindings(statement: B.ImportDeclaration) {
    const source = statement.source.value;
    const isExported = false;
    for (const specifier of statement.specifiers) {
      visitingNode(cur, specifier);
      const localName = specifier.local.name;
      const binding = createBindingAndSelfReference(localName, 'import', specifier, isExported);
      importBindings.set(binding, { source, specifier });
    }
  }

  function bindNamedExports(statement: B.ExportNamedDeclaration) {
    if (statement.source || statement.specifiers.length) {
      return compileError(cur, 'Only simple export syntax is supported')
    }

    const declaration = statement.declaration;
    if (!declaration) {
      // Older versions of babel didn't seem to allow for a null declaration,
      // so I'm thinking maybe it's to support a new language feature. I
      // haven't looked into it. (Note: this might be to support `export { x
      // as y }` syntax)
      return featureNotSupported(cur, 'Expected a declaration');
    }

    const isExported = true;
    if (declaration.type === 'VariableDeclaration') {
      bindVarDeclaration(declaration, isExported);
    } else if (declaration.type === 'FunctionDeclaration') {
      bindFunctionDeclaration(declaration, isExported);
    } else {
      return compileError(cur, `Not supported: export of ${declaration.type}`);
    }
  }

  function bindVarDeclaration(decl: B.VariableDeclaration, isExported: boolean) {
    for (const node of decl.declarations) {
      if (node.id.type !== 'Identifier') {
        return compileError(cur, 'Only simple variable declarations are supported.')
      }

      const name = node.id.name;
      if (!isNameString(name)) {
        return compileError(cur, `Invalid variable identifier: "${name}"`);
      }

      const binding = createBindingAndSelfReference(name, 'var', node, isExported);
      const scope = currentScope();
      if (scope.type === 'BlockScope') unexpected();
      scope.varDeclarations.push(binding);
    }
  }

  function pushModuleScope(node: ScopeNode) {
    const scope: ModuleScope = {
      type: 'ModuleScope',
      node,
      bindings: Object.create(null),
      children: [],
      references: [],
      parent: undefined,
      ilFunctionId: uniqueNameInSet('moduleEntry', ilFunctionNames),
      prologue: [],
      epiloguePopCount: 0,
      lexicalDeclarations: [],
      nestedFunctionDeclarations: [],
      varDeclarations: [],
      functionIsClosure: false,
      // Functions (such as the module entry function) automatically have their
      // scope popped when they return
      epiloguePopScope: false,
      sameLifetimeAsParent: false,
    };
    pushScope(node, scope);
    return scope;
  }

  function pushFunctionScope(node: B.SupportedFunctionNode, hasThisBinding: boolean) {
    const name = node.type === 'FunctionDeclaration' ? node.id?.name : undefined;
    if (name && !isNameString(name)) {
      return compileError(cur, `Invalid function identifier: "${name}`);
    }
    const ilFunctionId = uniqueNameInSet(name ?? 'anonymous', ilFunctionNames);
    const scope: FunctionScope = {
      type: 'FunctionScope',
      node,
      ilFunctionId,
      funcName: name,
      bindings: Object.create(null),
      children: [],
      references: [],
      parent: currentScope(),
      prologue: [],
      epiloguePopCount: 0,
      varDeclarations: [],
      lexicalDeclarations: [],
      nestedFunctionDeclarations: [],
      parameterBindings: [],
      // Assume the function is not a closure until we find a free variable
      // that references the outer scope
      functionIsClosure: false,
      // Functions automatically have their scope popped when they return
      epiloguePopScope: false,
      // Functions can obviously be multiply-instantiated relative to their containing scope
      sameLifetimeAsParent: false,
    };

    model.functions.push(scope);
    pushScope(node, scope);

    if (hasThisBinding) {
      scope.thisBinding = createBinding('#this', 'this', undefined, false);
    }

    return scope;
  }

  function pushBlockScope(node: ScopeNode, sameLifetimeAsParent: boolean) {
    const scope: BlockScope = {
      type: 'BlockScope',
      node,
      sameLifetimeAsParent,
      bindings: Object.create(null),
      children: [],
      references: [],
      parent: currentScope(),
      prologue: [],
      epiloguePopCount: undefined as any,
      epiloguePopScope: undefined as any,
      lexicalDeclarations: [],
      nestedFunctionDeclarations: [],
      closureSlots: undefined,
    };
    pushScope(node, scope);
    return scope;
  }

  function pushScope(node: ScopeNode, scope: Scope) {
    const parent = scopeStack[scopeStack.length - 1]; // Can be undefined
    scopes.set(node, scope);
    parent && parent.children.push(scope);
    scopeStack.push(scope);
  }

  function popScope(scope: Scope) {
    hardAssert(scopeStack[scopeStack.length - 1] === scope);
    scopeStack.pop();
  }

  function createParameterBindings(scope: FunctionScope, params: (B.FunctionDeclaration | B.ArrowFunctionExpression)['params']) {
    for (const param of params) {
      if (param.type !== 'Identifier') {
        return featureNotSupported(cur, 'Only simple parameters supported');
      }
      const binding = createBindingAndSelfReference(param.name, 'param', param, false);
      scope.parameterBindings.push(binding);
    }
  }

  function createBindingAndSelfReference(name: string, kind: Binding['kind'], node: BindingNode, isExported: boolean) {
    const binding = createBinding(name, kind, node, isExported);

    const selfReferenceNode = getDeclarationSelfReference(node)

    if (selfReferenceNode) {
      const ref: Reference = {
        name: name,
        isInLocalFunction: true,
        nearestScope: currentScope(),
        resolvesTo: { type: 'Binding', binding },
        access: undefined as any // Will be populated in a later phase
      };
      references.set(selfReferenceNode, ref)
      binding.selfReference = ref;
    }

    return binding;

    function getDeclarationSelfReference(node: BindingNode): B.Identifier | undefined {
      switch (node.type) {
        case 'FunctionDeclaration': return node.id ?? undefined;
        case 'Identifier': return node;
        case 'VariableDeclarator':
          return node.id.type === 'Identifier'
            ? node.id
            : undefined;
        case 'ImportDefaultSpecifier': return node.local;
        case 'ImportSpecifier': return node.local;
        case 'ImportNamespaceSpecifier': return node.local;
        default:
          return assertUnreachable(node);
      }
    }
  }

  function createBinding(
    name: string,
    kind: Binding['kind'],
    node: BindingNode | undefined,
    isExported: boolean
  ) {
    const readonly = kind === 'const';

    const scope = currentScope();
    const scopeBindings = scope.bindings;

    const isLexical = kind === 'let' || kind === 'const';

    if (isLexical && name in scopeBindings) {
      return compileError(cur, `Variable "${name}" already declared in scope`)
    }

    const binding: Binding = {
      kind,
      name,
      // We do slot assignment in a separate pass
      slot: undefined as any,
      scope: currentScope(),
      node,
      isExported,
      selfReference: undefined, // Populated later
      isDeclaredReadonly: readonly,
      // Assume by default that the variable is not written to,
      isWrittenTo: false,
      // Assuming not closure allocated until we detect otherwise
      isAccessedByNestedFunction: false,
    };

    scopeBindings[name] = binding;
    binding.node && bindings.set(binding.node, binding);

    isExported && model.exportedBindings.push(binding);

    return binding;
  }
}