import test from "node:test";
import assert from "node:assert/strict";
import { RelationshipContextManager } from "../src/services/RelationshipContextManager";

test("learns confirmed relationship and preserves high confidence", async () => {
  const manager = new RelationshipContextManager();
  const name = `Rahul-${Date.now()}`;
  const result = await manager.learnFromTurn(`${name} is my brother.`);

  assert.equal(result.changed, true);
  assert.equal(result.person?.relationships[0]?.type, "BROTHER");
  assert.equal(result.person?.relationships[0]?.status, "CONFIRMED");
  assert.equal(result.person?.relationships[0]?.confidence, 0.99);

  await manager.removePerson(result.person!.personId);
});

test("supports multiple personal and professional relationships for one person", async () => {
  const manager = new RelationshipContextManager();
  const name = `Rahul-${Date.now()}`;
  const result = await manager.learnFromTurn(`${name} is my brother and business partner.`);
  const relationships = result.person?.relationships || [];

  assert.deepEqual(relationships.map((item) => item.type).sort(), ["BROTHER", "BUSINESS_PARTNER"]);
  assert.equal(relationships.find((item) => item.type === "BROTHER")?.context, "PERSONAL");
  assert.equal(relationships.find((item) => item.type === "BUSINESS_PARTNER")?.context, "PROFESSIONAL");

  const professional = await manager.resolveTurnContext(`Should ${name} get equity in the company?`);
  assert.equal(professional?.context, "PROFESSIONAL");
  assert.equal(professional?.relationship, "BUSINESS_PARTNER");

  const personal = await manager.resolveTurnContext(`I am worried about my relationship with ${name}.`);
  assert.equal(personal?.context, "PERSONAL");
  assert.equal(personal?.relationship, "BROTHER");

  await manager.removePerson(result.person!.personId);
});

test("corrects a relationship without deleting historical evidence", async () => {
  const manager = new RelationshipContextManager();
  const name = `Anita-${Date.now()}`;
  const created = await manager.learnFromTurn(`${name} is my colleague.`);
  const corrected = await manager.learnFromTurn(`${name} isn't my colleague.`);
  const link = corrected.person?.relationships.find((item) => item.type === "COLLEAGUE");

  assert.equal(corrected.correction, true);
  assert.equal(link?.active, false);
  assert.equal(link?.status, "HISTORICAL");
  assert.ok(link?.history.some((item) => item.reason === "User correction"));

  await manager.removePerson(created.person!.personId);
});

test("stores collaboration inferred from conversation as uncertain", async () => {
  const manager = new RelationshipContextManager();
  const name = `Priya-${Date.now()}`;
  const result = await manager.learnFromTurn(`${name} is also helping me with the company.`);
  const link = result.person?.relationships[0];

  assert.equal(link?.type, "BUSINESS_COLLABORATOR");
  assert.equal(link?.status, "INFERRED");
  assert.equal(link?.confidence, 0.57);

  await manager.removePerson(result.person!.personId);
});

test("honors a natural privacy correction request", async () => {
  const manager = new RelationshipContextManager();
  const name = `Rahul-${Date.now()}`;
  const created = await manager.learnFromTurn(`${name} is my brother.`);
  const corrected = await manager.learnFromTurn(`Don't remember that ${name} is my brother.`);
  const link = corrected.person?.relationships.find((item) => item.type === "BROTHER");

  assert.equal(corrected.correction, true);
  assert.equal(link?.active, false);
  assert.equal(link?.status, "HISTORICAL");

  await manager.removePerson(created.person!.personId);
});
