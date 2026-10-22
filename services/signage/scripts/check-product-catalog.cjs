'use strict';
const fs=require('node:fs'),path=require('node:path');
const Products=require('../assets/products.js');
const input=process.argv[2]?path.resolve(process.argv[2]):path.join(__dirname,'../assets/product-catalog.json');
try {
  const data=JSON.parse(fs.readFileSync(input,'utf8')),registry=Products.createRegistry(data);
  const counts={};for(const t of registry.catalogue()){registry.validateProduct(registry.createProduct(t.type,t.id));counts[t.type]=(counts[t.type]||0)+1;}
  console.log(JSON.stringify({valid:true,revision:registry.catalogRevision,modules:registry.list().length,templates:registry.catalogue().length,categories:new Set(registry.catalogue().map(t=>t.category)).size,by_type:counts},null,2));
} catch(error){console.error(error.message);process.exitCode=1;}
