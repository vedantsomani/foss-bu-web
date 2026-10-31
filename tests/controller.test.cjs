const assert = require('node:assert/strict');
const {gameKeys, lookDelta} = require('../public/controller.js');
const pad = () => ({axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,value:0}))});
let p=pad(); assert.deepEqual([...gameKeys(p)],[]);
p.axes=[-0.8,-0.8,0.8,0];p.buttons[7].value=0.9;p.buttons[2].pressed=true;
assert.deepEqual([...gameKeys(p)].sort((a,b)=>a-b),[17,65,69,87]);
p=pad();p.axes=[0.12,-0.12,0.12];assert.equal(gameKeys(p,0.25).size,0);
p.buttons[9].pressed=true;p.buttons[0].pressed=true;p.buttons[3].pressed=true;
assert.deepEqual([...gameKeys(p)].sort((a,b)=>a-b),[9,13,27,32]);
assert.equal(gameKeys({axes:[],buttons:[]}).size,0);
// Right stick drives the camera through mouse motion: none inside the deadzone, more with more deflection.
p=pad();p.axes=[0,0,0.1,0.1];assert.deepEqual(lookDelta(p,0.25),[0,0]);
p.axes=[0,0,0.5,0];const half=lookDelta(p,0.25)[0];p.axes=[0,0,1,0];const full=lookDelta(p,0.25)[0];
assert.ok(half>0&&full>half*3,'squared response curve');
p.axes=[0,0,0,1];assert.ok(lookDelta(p,0.25)[1]>0,'stick down looks down');
console.log('Controller mapping, deadzone, look curve and missing-input tests passed');
