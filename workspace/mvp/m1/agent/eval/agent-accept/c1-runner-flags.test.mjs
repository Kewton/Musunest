import test from "node:test";
import assert from "node:assert/strict";
import { parseC1Flags, c1Argv, c1BuildReport, c1ConditionsMatch } from "./c1-runner-flags.mjs";
const mode={pipeline:"v1.2",buildFrom:"synthetic",plan:false,planOnly:false,compare:false,makePairs:false,stageMode:false};
const parse=(args,m=mode)=>parseC1Flags(["repo","out",...args],m);
test("S-175ac flags off preserve omitted representation, on order is deterministic and independent",()=>{
 assert.deepEqual(parse([]),{});assert.deepEqual(parse(["--c1-reference-enum","off","--c1-conditional-fields","off"]),{});
 const flags=parse(["--c1-conditional-fields","on","--c1-reference-enum","on"]);
 assert.deepEqual(c1Argv(flags),["--c1-reference-enum","on","--c1-conditional-fields","on"]);
 assert.deepEqual(c1Argv(parse(["--c1-conditional-fields","on"])),["--c1-conditional-fields","on"]);
});
test("S-175ac unknown/missing/duplicate values and unsupported modes fail closed",()=>{
 for(const args of [["--c1-new","on"],["--c1-reference-enum"],["--c1-reference-enum","bad"],["--c1-reference-enum","on","--c1-reference-enum","off"]])assert.throws(()=>parse(args));
 for(const changed of [{pipeline:"v1"},{buildFrom:null},{plan:true},{planOnly:true},{compare:true},{makePairs:true},{stageMode:true}])assert.throws(()=>parse(["--c1-reference-enum","on"],{...mode,...changed}));
});
test("S-175ac native Build reports must match actual requested flags, including missing and tampered records",()=>{
 const f=parse(["--c1-reference-enum","on"]);
 assert.equal(c1BuildReport(f,{conditions:f}).status,"match");
 for(const record of [null,{}, {conditions:null}])assert.equal(c1BuildReport(f,record).status,"missing");
 for(const values of [{}, {c1_reference_enum:"off"},{c1_reference_enum:true},{c1_reference_enum:null}])assert.notEqual(c1BuildReport(f,{conditions:values}).status,"match");
 assert.equal(c1BuildReport({},null).status,"match");assert.equal(c1ConditionsMatch({},f),false);
});

test("S-175ad C2 is independent, off stays omitted and native C2 report must match",()=>{
 assert.deepEqual(parse(["--c2-mapping-contract","off"]),{});
 const f=parse(["--c2-mapping-contract","on"]);assert.deepEqual(f,{c2_mapping_contract:"on"});
 assert.deepEqual(c1Argv(f),["--c2-mapping-contract","on"]);
 assert.equal(c1BuildReport(f,{conditions:f}).status,"match");assert.equal(c1BuildReport(f,{conditions:{}}).status,"mismatch");
 assert.equal(c1ConditionsMatch({},f),false);
 for(const args of [["--c2-mapping-contract"],["--c2-mapping-contract","bad"],["--c2-mapping-contract","on","--c2-mapping-contract","off"],["--c2-other","on"]])assert.throws(()=>parse(args));
});
