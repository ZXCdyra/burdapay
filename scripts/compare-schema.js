#!/usr/bin/env node
/**
 * Compare Prisma schema models with actual database tables.
 * Shows which tables exist in DB but not in schema, and vice versa.
 */
const { PrismaClient } = require('@prisma/client');
const { execSync } = require('child_process');

async function main() {
  console.log('=== DATABASE STATE ===\n');

  const prisma = new PrismaClient();

  // Get all tables in database
  const tables = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
  );

  console.log('Tables in database:', tables.map(t => t.table_name).join(', '));
  console.log(`Total: ${tables.length} tables\n`);

  // Check Prisma schema models
  let schemaContent;
  try {
    schemaContent = require('fs').readFileSync('prisma/schema.prisma', 'utf-8');
  } catch {
    console.log('Cannot read prisma/schema.prisma');
    return;
  }

  const schemaModels = [];
  const modelRegex = /^model\s+(\w+)/gm;
  let match;
  while ((match = modelRegex.exec(schemaContent)) !== null) {
    schemaModels.push(match[1]);
  }

  console.log('Models in schema:', schemaModels.join(', '));
  console.log(`Total: ${schemaModels.length} models\n`);

  // Compare
  const dbTables = new Set(tables.map(t => t.table_name));
  const schemaModelsSet = new Set(schemaModels);

  console.log('=== COMPARISON ===\n');

  const inDBNotInSchema = tables.filter(t => !schemaModelsSet.has(t.table_name));
  const inSchemaNotInDB = schemaModels.filter(m => !dbTables.has(m));

  if (inDBNotInSchema.length > 0) {
    console.log(`⚠️  Tables in DB but NOT in schema (${inDBNotInSchema.length}):`);
    inDBNotInSchema.forEach(t => console.log(`   - ${t.table_name}`));
    console.log('');
  }

  if (inSchemaNotInDB.length > 0) {
    console.log(`⚠️  Models in schema but NOT in DB (${inSchemaNotInDB.length}):`);
    inSchemaNotInDB.forEach(m => console.log(`   - ${m}`));
    console.log('');
  }

  if (inDBNotInSchema.length === 0 && inSchemaNotInDB.length === 0) {
    console.log('✓ Schema matches database tables exactly');
  }

  // Check for missing columns in key tables
  console.log('\n=== SCHEMA FIELD COMPARISON ===\n');
  const keyTables = ['Merchant', 'Trader', 'AdminUser', 'Order', 'DepositRequest'];
  
  for (const tableName of keyTables) {
    try {
      const columns = await prisma.$queryRawUnsafe(
        `SELECT column_name, data_type, is_nullable 
         FROM information_schema.columns 
         WHERE table_name = $1 AND table_schema = 'public'
         ORDER BY ordinal_position`,
        tableName
      );

      // Extract fields from schema
      const schemaModelMatch = schemaContent.match(
        new RegExp(`model\\s+${tableName}\\s*\\{([^}]+)\\}`, 's')
      );

      const schemaFields = new Set();
      if (schemaModelMatch) {
        const fieldRegex = /^\s+(\w+)\s+(.+)$/gm;
        let f;
        while ((f = fieldRegex.exec(schemaModelMatch[1])) !== null) {
          schemaFields.add(f[1]);
        }
      }

      console.log(`${tableName}:`);
      const dbColumns = new Set(columns.map(c => c.column_name));

      for (const f of schemaFields) {
        if (!dbColumns.has(f)) {
          console.log(`   ❌ Schema field "${f}" not in DB`);
        }
      }
      for (const c of dbColumns) {
        if (!schemaFields.has(c)) {
          console.log(`   ℹ️  DB column "${c}" not in schema`);
        }
      }
      console.log('');
    } catch (e) {
      console.log(`${tableName}: error - ${e.message}\n`);
    }
  }

  await prisma.$disconnect();
}

main().catch(console.error);
