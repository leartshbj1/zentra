import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootRequire = createRequire(resolve(root, 'package.json'));
const micromatchPath = rootRequire.resolve('micromatch', { paths: [resolve(root, 'node_modules/.pnpm/node_modules')] });
const installedRequire = createRequire(micromatchPath);
const bracesPath = installedRequire.resolve('braces');
const braces = installedRequire('braces');
const micromatch = rootRequire(micromatchPath);
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/braces-3.0.3-compatibility.json', import.meta.url), 'utf8'));
const methods = ['default', 'compile', 'expand', 'stringify'];
const nested = (depth, open = '{', close = '}') => open.repeat(depth) + 'x' + close.repeat(depth);
const depthFailure = error => error instanceof SyntaxError && error.message === 'Brace pattern nesting exceeds max depth (100)';
function outcome(method, value, options) {
  try { return { value: method === 'default' ? braces(value, options) : braces[method](value, options) }; }
  catch (error) { return { error: error.name, message: error.message }; }
}

test('loads the actual patched package through the installed micromatch dependency', () => {
  assert.equal(installedRequire('braces/package.json').version, '3.0.3');
  assert.match(realpathSync(bracesPath), /patch_hash=/);
  assert.equal(installedRequire('braces/lib/depth').MAX_DEPTH, 100);
  assert.equal(fixtures.source.package, 'braces@3.0.3');
});

test('the actual consumer preserves ordinary matching and forwards depth rejection', () => {
  assert.deepEqual(micromatch(['src/a.ts', 'src/b.tsx', 'src/a.css', 'lib/a.ts'], 'src/*.{ts,tsx}'), ['src/a.ts', 'src/b.tsx']);
  assert.deepEqual(micromatch.braces('src/{a,b}.ts'), ['src/(a|b).ts']);
  assert.throws(() => micromatch.braces(nested(101)), depthFailure);
});

for (const [index, fixture] of fixtures.cases.entries()) {
  test(`upstream compatibility ${index + 1}: ${fixture.input.length > 80 ? 'depth boundary' : fixture.input}`, () => {
    for (const method of methods) assert.deepEqual(outcome(method, fixture.input, fixture.options), fixture.expected[method], method);
  });
}

test('all string entry points accept 100 nested blocks and reject 101, including mixed parentheses', () => {
  const boundaries = [nested(100), nested(100, '(', ')'), '('.repeat(50) + nested(50) + ')'.repeat(50)];
  const tooDeep = [nested(101), nested(101, '(', ')'), '('.repeat(50) + nested(51) + ')'.repeat(50), '{'.repeat(101)];
  for (const input of boundaries) {
    assert.doesNotThrow(() => braces.parse(input));
    for (const method of methods) assert.ok(Object.hasOwn(outcome(method, input, {}), 'value'), method);
  }
  for (const input of tooDeep) {
    assert.throws(() => braces.parse(input), depthFailure);
    for (const method of methods) assert.throws(() => method === 'default' ? braces(input) : braces[method](input), depthFailure);
  }
  for (const options of [{ maxDepth: false }, { maxDepth: Infinity }, { maxDepth: 10000, maxLength: 100000 }]) assert.throws(() => braces.compile(nested(101), options), depthFailure);
});

test('deep-looking quotes, character classes and escapes remain literals', () => {
  const literal = '{'.repeat(3000);
  for (const input of ['"' + literal + '"', "'" + literal + "'", '`' + literal + '`', '\\{'.repeat(3000)]) {
    assert.equal(braces.compile(input), literal);
    assert.deepEqual(braces.expand(input), [literal]);
  }
  const characterClass = '[' + nested(1000) + ']';
  assert.equal(braces.compile(characterClass), characterClass);
  assert.deepEqual(braces.expand(characterClass), [characterClass]);
});

function directAst(depth) {
  const ast = { type: 'root', nodes: [] };
  let parent = ast;
  for (let i = 0; i < depth; i++) {
    const node = { type: 'paren', nodes: [], parent };
    parent.nodes.push(node); parent = node;
  }
  parent.nodes.push({ type: 'text', value: 'x', parent });
  return ast;
}
test('direct AST walkers enforce the same depth ceiling without following ordinary parent links', () => {
  for (const method of methods.slice(1)) {
    assert.deepEqual(braces[method](directAst(100)), method === 'expand' ? ['x'] : 'x');
    assert.throws(() => braces[method](directAst(101)), depthFailure);
  }
});

test('valid AST subtree reuse is allowed after each path completes', () => {
  for (const method of methods.slice(1)) {
    const ast = braces.parse('{a,b}'), brace = ast.nodes.find(node => node.type === 'brace');
    assert.equal(brace.parent, ast);
    ast.nodes.splice(ast.nodes.length - 1, 0, brace);
    assert.deepEqual(outcome(method, ast, {}), fixtures.sharedExpected[method], method);
  }
});

test('only recursively visited child cycles are rejected, not ignored links or sibling reuse', () => {
  for (const method of methods.slice(1)) {
    const ast = { type: 'root', nodes: [] }; ast.nodes.push(ast);
    assert.throws(() => braces[method](ast), error => error instanceof SyntaxError && error.message === 'Cyclic brace AST');
    const leaf = { type: 'text', value: 'literal', nodes: [] }; leaf.nodes.push(leaf); leaf.parent = leaf; leaf.prev = leaf;
    const rootAst = { type: 'root', nodes: [leaf, leaf] };
    assert.deepEqual(braces[method](rootAst), method === 'expand' ? ['literalliteral'] : 'literalliteral');
  }
});

test('the default stack and a 512 KiB stack reject malicious inputs in a bounded subprocess', () => {
  const script = `const assert=require('node:assert/strict');const braces=require(${JSON.stringify(bracesPath)});const methods=['default','compile','expand','stringify','parse'];let refusals=0,accepted=0,astRefusals=0;for(const input of ['{'.repeat(4000)+'x'+'}'.repeat(4000),'('.repeat(4000)+'x'+')'.repeat(4000)]){assert.ok(input.length<10000);for(const method of methods){assert.throws(()=>method==='default'?braces(input):braces[method](input),e=>e instanceof SyntaxError&&e.message==='Brace pattern nesting exceeds max depth (100)');refusals++;}}for(const input of ['{'.repeat(100)+'x'+'}'.repeat(100),'('.repeat(100)+'x'+')'.repeat(100)])for(const method of methods){assert.doesNotThrow(()=>method==='default'?braces(input):braces[method](input));accepted++;}function deep(){const root={type:'root',nodes:[]};let parent=root;for(let n=0;n<4000;n++){const node={type:'paren',nodes:[],parent};parent.nodes.push(node);parent=node;}parent.nodes.push({type:'text',value:'x',parent});return root;}for(const method of methods.slice(1,4)){const cycle={type:'root',nodes:[]};cycle.nodes.push(cycle);for(const ast of [deep(),cycle]){assert.throws(()=>braces[method](ast),e=>e instanceof SyntaxError&&/max depth|Cyclic brace AST/.test(e.message));astRefusals++;}}assert.equal(braces.compile('{a,b}'),'(a|b)');process.stdout.write(JSON.stringify({refusals,accepted,astRefusals,usableAfterRejection:true}));`;
  for (const stack of [[], ['--stack-size=512']]) {
    const result = spawnSync(process.execPath, ['--max-old-space-size=64', ...stack, '--input-type=commonjs', '-e', script], { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { refusals: 10, accepted: 10, astRefusals: 6, usableAfterRejection: true });
  }
});

test('length and range guards from upstream remain enabled', () => {
  assert.throws(() => braces.parse('x'.repeat(10001)), error => error instanceof SyntaxError && /max characters/.test(error.message));
  assert.throws(() => braces.expand('{1..1001}'), error => error instanceof RangeError && /range limit/.test(error.message));
});
