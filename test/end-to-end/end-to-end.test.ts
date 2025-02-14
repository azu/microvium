import glob from 'glob';
import * as path from 'path';
import os from 'os';
import fs from 'fs-extra';
import * as IL from '../../lib/il';
import { VirtualMachineFriendly } from '../../lib/virtual-machine-friendly';
import { stringifySnapshotIL } from '../../lib/snapshot-il';
import { htmlPageTemplate } from '../../lib/general';
import YAML from 'yaml';
import { Microvium, HostImportTable } from '../../lib';
import { assertSameCode } from '../common';
import { assert } from 'chai';
import { NativeVM, CoverageCaseMode } from '../../lib/native-vm';
import colors from 'colors';
import { getCoveragePoints, updateCoverageMarkers, CoverageHitInfos } from '../../lib/code-coverage-utils';
import { notUndefined, writeTextFile } from '../../lib/utils';
import { encodeSnapshot } from '../../lib/encode-snapshot';
import { decodeSnapshot } from '../../lib/decode-snapshot';
import { compileScript, parseToAst } from '../../lib/src-to-il/src-to-il';
import { stringifyUnit } from '../../lib/stringify-il';
import { stringifyAnalysis } from '../../lib/src-to-il/analyze-scopes/stringify-analysis';
import { analyzeScopes } from '../../lib/src-to-il/analyze-scopes';

/*
 * TODO I think it would make sense at this point to have a custom test
 * framework rather than using Mocha. Some features I want:
 *
 *   - Builtin support for file-based tests (where test cases are directories)
 *   - Builtin support for approving file-based test output
 *   - Support for masking multiple tests to be run (mocha's "only" seems to
 *     only work for a single test, and its implementation is flawed). For a
 *     workflow where a big change affects multiple tests and I want to work
 *     through them one by one. Maybe a test-matrix file that lists all the
 *     tests and whether they should be run or not.
 */

const testDir = './test/end-to-end/tests';
const rootArtifactDir = './test/end-to-end/artifacts';
const testFiles = glob.sync(testDir + '/**/*.test.mvm.js');

const HOST_FUNCTION_PRINT_ID: IL.HostFunctionID = 1;
const HOST_FUNCTION_ASSERT_ID: IL.HostFunctionID = 2;
const HOST_FUNCTION_ASSERT_EQUAL_ID: IL.HostFunctionID = 3;
const HOST_FUNCTION_GET_HEAP_USED_ID: IL.HostFunctionID = 4;
const HOST_FUNCTION_RUN_GC_ID: IL.HostFunctionID = 5;

interface TestMeta {
  description?: string;
  runExportedFunction?: IL.ExportID;
  expectedPrintout?: string;
  expectException?: string;
  testOnly?: boolean;
  skip?: boolean;
  skipNative?: boolean;
  nativeOnly?: boolean;
  assertionCount?: number; // Expected assertion count for each call of the runExportedFunction function
  dontCompareDisassembly?: boolean;
}

const microviumCFilename = './native-vm/microvium.c';
const coveragePoints = getCoveragePoints(fs.readFileSync(microviumCFilename, 'utf8').split(/\r?\n/g), microviumCFilename);

suite('end-to-end', function () {
  let anySkips = false;
  let anyFailures = false;
  const anyGrepSelector = process.argv.some(x => x === '-g' || x === '--grep');

  const coverageHits: CoverageHitInfos = {};

  this.beforeAll(() => {
    NativeVM.setCoverageCallback((id, mode, indexInTable, tableSize, line) => {
      let hitInfo = coverageHits[id];
      if (!hitInfo) {
        hitInfo = { lineHitCount: 0 };
        if (mode === CoverageCaseMode.TABLE) {
          hitInfo.hitCountByTableEntry = {};
          hitInfo.tableSize = tableSize;
        }
        coverageHits[id] = hitInfo;
      }
      hitInfo.lineHitCount++;
      if (mode === CoverageCaseMode.TABLE) {
        const tableHitCount = notUndefined(hitInfo.hitCountByTableEntry);
        tableHitCount[indexInTable] = (tableHitCount[indexInTable] || 0) + 1;
      }
    });
  })

  this.afterEach(function() {
    if (this.currentTest && this.currentTest.isFailed()) {
      anyFailures = true;
    }
  })

  this.afterAll(function() {
    NativeVM.setCoverageCallback(undefined);

    const summaryPath = path.resolve(rootArtifactDir, 'code-coverage-summary.txt');

    let coverageHitLocations = 0;
    let coveragePossibleHitLocations = 0;
    for (const c of coveragePoints) {
      const hitInfo = coverageHits[c.id];
      if (!hitInfo) {
        coveragePossibleHitLocations++;
      } else {
        if (hitInfo.tableSize !== undefined) {
          coveragePossibleHitLocations += hitInfo.tableSize;
        } else {
          coveragePossibleHitLocations++;
        }
        if (hitInfo.hitCountByTableEntry !== undefined) {
          const numberOfItemsInTableThatWereHit = Object.keys(hitInfo.hitCountByTableEntry).length;
          coverageHitLocations += numberOfItemsInTableThatWereHit;
        } else {
          // Else we just say that the line was hit
          coverageHitLocations++;
        }
      }
    }

    if (!anyGrepSelector && !anySkips && !anyFailures) {
      const coverageOneLiner = `${coverageHitLocations} of ${coveragePossibleHitLocations} (${(coverageHitLocations / coveragePossibleHitLocations * 100).toFixed(1)}%)`;
      const microviumCFilenameRelative = path.relative(process.cwd(), microviumCFilename);
      writeTextFile(path.resolve(rootArtifactDir, 'code-coverage-details.json'), JSON.stringify(coverageHits));
      const summaryLines = [`microvium.c code coverage: ${coverageOneLiner}`];
      writeTextFile(summaryPath, summaryLines.join(os.EOL));

      const expectedButNotHit = coveragePoints
        .filter(p => (p.type === 'normal') && !coverageHits[p.id]);
      updateCoverageMarkers(true, !anySkips && !anyFailures && !anyGrepSelector);
      if (expectedButNotHit.length) {
        throw new Error('The following coverage points were expected but not hit in the tests\n' +
          expectedButNotHit
            .map(p => `      at ${microviumCFilenameRelative}:${p.lineI + 1} ID(${p.id})`)
            .join('\n  '))
      }
      console.log(`    ${colors.green('√')} ${colors.gray('end-to-end microvium.c code coverage: ')}${coverageOneLiner}`);
    }
  });

  // The main reason to enumerate the cases in advance is so we can determine
  // `anySkips` in advance
  const cases = [...enumerateCases(testFiles)];

  anySkips = cases.some(({ meta }) => !!meta.skip || !!meta.skipNative || !!meta.testOnly)

  for (const testCase of cases) {
    const {
      meta,
      testFriendlyName,
      testArtifactDir,
      yamlText,
      src,
      testFilenameRelativeToCurDir,
    } = testCase;

    if (meta.skip) {
      // If a test is skipped, it's good to still output the updated yaml file
      // so that the C++ tests can access this yaml file and know that they also
      // need to skip the tests
      writeTextFile(path.resolve(testArtifactDir, '0.meta.yaml'), yamlText || '');
    }

    const runner =
      meta.skip ? test.skip :
      meta.testOnly ? test.only :
      test;

    // The reason I'm using this container is just when you're debugging it's
    // nice to see the test case name show up in the call stack, which requires
    // that we can name the function dynamically
    const testContainer = {
      [testFriendlyName]() {
        // It's convenient not to wipe the test output if we're only running a
        // subset of the cases, otherwise un-run cases show up in the git diff as
        // "deleted" files. But it's good to remove the test output before a full
        // run confirm that no test output is the result of an old run.
        if (!anySkips && !anyGrepSelector) {
          fs.emptyDirSync(testArtifactDir);
        } else {
          fs.ensureDirSync(testArtifactDir);
        }
        writeTextFile(path.resolve(testArtifactDir, '0.meta.yaml'), yamlText || '');

        // ------------------------- Set up Environment -------------------------

        let printLog: string[] = [];
        let assertionCount = 0;

        function print(v: any) {
          printLog.push(typeof v === 'string' ? v : JSON.stringify(v));
        }

        function vmExport(exportID: IL.ExportID, fn: any) {
          vm.vmExport(exportID, fn);
        }

        function vmAssert(predicate: boolean, message: string) {
          assertionCount++;
          if (!predicate) {
            throw new Error('Failed assertion' + (message ? ' ' + message : ''));
          }
        }

        function vmAssertEqual(a: any, b: any) {
          assertionCount++;
          if (a !== b) {
            throw new Error(`Expected ${a} to equal ${b}`);
          }
        }

        function vmGetHeapUsed() {
          // We'll override this at runtime
          return 0;
        }

        function vmRunGC() {
          vm.garbageCollect();
        }

        const importMap: HostImportTable = {
          [HOST_FUNCTION_PRINT_ID]: print,
          [HOST_FUNCTION_ASSERT_ID]: vmAssert,
          [HOST_FUNCTION_ASSERT_EQUAL_ID]: vmAssertEqual,
          [HOST_FUNCTION_GET_HEAP_USED_ID]: vmGetHeapUsed,
          [HOST_FUNCTION_RUN_GC_ID]: vmRunGC,
        };

        // The `compileScript` pass also produces the same analysis but in case
        // the compilation fails, it's useful to have the scope analysis early.
        const analysis = analyzeScopes(parseToAst(testFilenameRelativeToCurDir, src), testFilenameRelativeToCurDir);
        writeTextFile(path.resolve(testArtifactDir, '0.scope-analysis'), stringifyAnalysis(analysis));

        // Note: this unit is not used for execution. It's just for generating diagnostic IL
        const { unit } = compileScript(testFilenameRelativeToCurDir, src);
        writeTextFile(path.resolve(testArtifactDir, '0.unit.il'), stringifyUnit(unit, { showComments: true }));

        // ------------------- Create VirtualMachineFriendly ------------------

        const vm = VirtualMachineFriendly.create(importMap, {
          // Match behavior of NativeVM for overflow checking. This allows us to
          // compile with either overflow checks enabled or not and have
          // consistent results from the tests.
          overflowChecks: NativeVM.MVM_PORT_INT32_OVERFLOW_CHECKS
        });
        const vmGlobal = vm.globalThis;
        vmGlobal.print = vm.importHostFunction(HOST_FUNCTION_PRINT_ID);
        vmGlobal.assert = vm.importHostFunction(HOST_FUNCTION_ASSERT_ID);
        vmGlobal.assertEqual = vm.importHostFunction(HOST_FUNCTION_ASSERT_EQUAL_ID);
        vmGlobal.getHeapUsed = vm.importHostFunction(HOST_FUNCTION_GET_HEAP_USED_ID);
        vmGlobal.runGC = vm.importHostFunction(HOST_FUNCTION_RUN_GC_ID);
        vmGlobal.vmExport = vmExport;
        vmGlobal.overflowChecks = NativeVM.MVM_PORT_INT32_OVERFLOW_CHECKS;
        const vmConsole = vmGlobal.console = vm.newObject();
        vmConsole.log = vmGlobal.print; // Alternative way of accessing the print function

        // ---------------------------- Load Source ---------------------------

        // TODO: Nested import
        vm.evaluateModule({ sourceText: src, debugFilename: testFilenameRelativeToCurDir });

        const postLoadSnapshotInfo = vm.createSnapshotIL();
        writeTextFile(path.resolve(testArtifactDir, '1.post-load.snapshot'), stringifySnapshotIL(postLoadSnapshotInfo, {
          // commentSourceLocations: true
        }));
        const { snapshot: postLoadSnapshot, html: postLoadHTML } = encodeSnapshot(postLoadSnapshotInfo, true);
        fs.writeFileSync(path.resolve(testArtifactDir, '1.post-load.mvm-bc'), postLoadSnapshot.data, null);
        writeTextFile(path.resolve(testArtifactDir, '1.post-load.mvm-bc.html'), htmlPageTemplate(postLoadHTML!));
        const decoded = decodeSnapshot(postLoadSnapshot);
        writeTextFile(path.resolve(testArtifactDir, '1.post-load.mvm-bc.disassembly'), decoded.disassembly);
        if (!meta.dontCompareDisassembly) {
          // This checks that a round-trip serialization and deserialization of
          // the post-load snapshot gives us the same thing.
          assertSameCode(
            stringifySnapshotIL(decoded.snapshotInfo, {
              showComments: false,
              cullUnreachableBlocks: true,
              cullUnreachableInstructions: true
            }),
            stringifySnapshotIL(postLoadSnapshotInfo, {
              showComments: false,
              cullUnreachableBlocks: true,
              cullUnreachableInstructions: true
            })
          );
        }

        // ---------------------------- Run Function ----------------------------

        if (meta.runExportedFunction !== undefined && !meta.nativeOnly) {
          const functionToRun = vm.resolveExport(meta.runExportedFunction);
          assertionCount = 0;
          if (meta.expectException) {
            let threw = undefined;
            try {
              functionToRun();
            } catch (e) {
              threw = e;
            }
            if (!threw) {
              assert(false, 'Expected exception to be thrown but none thrown')
            }
            assert.deepEqual(threw, meta.expectException)
          } else {
            functionToRun();
          }
          writeTextFile(path.resolve(testArtifactDir, '2.post-run.print.txt'), printLog.join('\n'));
          if (meta.expectedPrintout !== undefined) {
            assertSameCode(printLog.join('\n'), meta.expectedPrintout);
          }
          if (meta.assertionCount !== undefined) {
            assert.equal(assertionCount, meta.assertionCount, 'Expected assertion count');
          }
        }

        // --------------------- Run function in native VM ---------------------

        if (!meta.skipNative) {
          printLog = [];

          function vmGetHeapUsed() {
            const memoryStats = nativeVM.getMemoryStats();
            return memoryStats.virtualHeapUsed;
          }

          function vmRunGC(squeeze?: boolean) {
            nativeVM.garbageCollect(squeeze);
          }

          importMap[HOST_FUNCTION_GET_HEAP_USED_ID] = vmGetHeapUsed;
          importMap[HOST_FUNCTION_RUN_GC_ID] = vmRunGC;

          const nativeVM = Microvium.restore(postLoadSnapshot, importMap);

          const preRunSnapshot = nativeVM.createSnapshot();
          writeTextFile(path.resolve(testArtifactDir, '3.native-pre-run.mvm-bc.disassembly'), decodeSnapshot(preRunSnapshot).disassembly);

          // The garbage collection here shouldn't do anything, because it's already compacted
          nativeVM.garbageCollect(true);

          // Note: after the GC, things may have moved around in memory
          writeTextFile(path.resolve(testArtifactDir, '3.native-post-gc.mvm-bc.disassembly'), decodeSnapshot(nativeVM.createSnapshot()).disassembly);

          if (meta.runExportedFunction !== undefined) {
            const run = nativeVM.resolveExport(meta.runExportedFunction);
            assertionCount = 0;

            if (meta.expectException) {
              let threw = undefined;
              try {
                run();
              } catch (e) {
                threw = e;
              }
              if (!threw) {
                assert(false, 'Expected exception to be thrown but none thrown')
              }
              assert.deepEqual(threw.message, meta.expectException)
            } else {
              run();
            }

            const postRunSnapshot = nativeVM.createSnapshot();
            fs.writeFileSync(path.resolve(testArtifactDir, '4.native-post-run.mvm-bc'), postRunSnapshot.data, null);

            writeTextFile(path.resolve(testArtifactDir, '4.native-post-run.mvm-bc.disassembly'), decodeSnapshot(postRunSnapshot).disassembly);

            writeTextFile(path.resolve(testArtifactDir, '4.native-post-run.print.txt'), printLog.join('\n'));
            if (meta.expectedPrintout !== undefined) {
              assertSameCode(printLog.join('\n'), meta.expectedPrintout);
            }
            if (meta.assertionCount !== undefined) {
              assert.equal(assertionCount, meta.assertionCount, 'Expected assertion count');
            }

            nativeVM.garbageCollect(true);
            const postGCSnapshot = nativeVM.createSnapshot();
            writeTextFile(path.resolve(testArtifactDir, '5.native-post-gc.mvm-bc.disassembly'), decodeSnapshot(postGCSnapshot).disassembly);
          }
        }
      }
    };

    runner(testFriendlyName, testContainer[testFriendlyName]);
  }
});

function* enumerateCases(testFiles: string[]) {
  for (const filename of testFiles) {
    const testFilenameFull = path.resolve(filename);
    const testFilenameRelativeToTestDir = path.relative(testDir, testFilenameFull);
    const testFilenameRelativeToCurDir = './' + path.relative(process.cwd(), testFilenameFull).replace(/\\/g, '/');
    const testFriendlyName = testFilenameRelativeToTestDir.slice(0, -12);
    const testArtifactDir = path.resolve(rootArtifactDir, testFilenameRelativeToTestDir.slice(0, -12));

    const src = fs.readFileSync(testFilenameRelativeToCurDir, 'utf8');

    const yamlHeaderMatch = src.match(/\/\*---(.*?)---\*\//s);
    const yamlText = yamlHeaderMatch
      ? yamlHeaderMatch[1].trim()
      : undefined;
    const meta: TestMeta = yamlText
      ? YAML.parse(yamlText)
      : {};

    yield {
      meta,
      testFriendlyName,
      testArtifactDir,
      yamlText,
      src,
      testFilenameRelativeToCurDir,
    }
  }
}