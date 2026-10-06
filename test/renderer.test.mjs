import test from 'node:test';import assert from 'node:assert/strict';import {hit,exportName,newLayer} from '../renderer.js';
test('rotated layer hit testing follows rotated coordinates',()=>{const l={x:100,y:100,w:200,h:40,rotation:90};assert.equal(hit(l,100,180),true);assert.equal(hit(l,180,100),false);});
test('export names distinguish identical basenames and remove unsafe characters',()=>{assert.equal(exportName('a:b.jpg',0),'001_a_b.png');assert.notEqual(exportName('image.jpg',0),exportName('image.png',1));});
test('layer defaults scale with original image dimensions',()=>{const l=newLayer('bubble',1000,800);assert.equal(l.x,500);assert.equal(l.size,40);assert.equal(l.kind,'bubble');});
