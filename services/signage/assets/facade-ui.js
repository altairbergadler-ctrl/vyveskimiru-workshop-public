/* Facade overlay and coordinate-only alignment. Photo pixels are never changed. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SignageFacadeUI=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const finitePoint=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite);
  const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const defaults=()=>({version:1,enabled:true,lens_enabled:false,edge_points:[null,null,null,null],grid_visible:true,grid_step_cm:50,snap_elements:true,snap_grid:true});
  function normalize(value){
    if(!value||typeof value!=='object')return null;
    const base=defaults();
    return {...base,enabled:value.enabled===true,lens_enabled:value.lens_enabled===true,
      edge_points:Array.from({length:4},(_,i)=>finitePoint(value.edge_points?.[i])?[...value.edge_points[i]]:null),
      grid_visible:value.grid_visible!==false,grid_step_cm:Number.isFinite(value.grid_step_cm)&&value.grid_step_cm>=5?value.grid_step_cm:50,
      snap_elements:value.snap_elements!==false,snap_grid:value.snap_grid!==false};
  }
  function bounds(points){if(!Array.isArray(points)||!points.length||!points.every(finitePoint))return null;return {minX:Math.min(...points.map(p=>p[0])),maxX:Math.max(...points.map(p=>p[0])),minY:Math.min(...points.map(p=>p[1])),maxY:Math.max(...points.map(p=>p[1]))};}
  function clipSegment(a,b,polygon){
    if(!finitePoint(a)||!finitePoint(b)||!Array.isArray(polygon)||polygon.length<3||!polygon.every(finitePoint))return null;
    const area=polygon.reduce((sum,p,i)=>{const q=polygon[(i+1)%polygon.length];return sum+p[0]*q[1]-q[0]*p[1];},0),winding=area>=0?1:-1;
    let enter=0,leave=1;const direction=[b[0]-a[0],b[1]-a[1]];
    for(let i=0;i<polygon.length;i++){
      const p=polygon[i],q=polygon[(i+1)%polygon.length],edge=[q[0]-p[0],q[1]-p[1]],relative=[a[0]-p[0],a[1]-p[1]];
      const start=winding*(edge[0]*relative[1]-edge[1]*relative[0]),slope=winding*(edge[0]*direction[1]-edge[1]*direction[0]);
      if(Math.abs(slope)<1e-12){if(start < -1e-7)return null;continue;}
      const crossing=-start/slope;if(slope>0)enter=Math.max(enter,crossing);else leave=Math.min(leave,crossing);if(enter>leave+1e-12)return null;
    }
    if(leave<0||enter>1)return null;enter=Math.max(0,Math.min(1,enter));leave=Math.max(enter,Math.min(1,leave));
    return [enter,leave].map(t=>[a[0]+direction[0]*t,a[1]+direction[1]*t]);
  }
  function inside(p,polygon){if(!finitePoint(p)||!Array.isArray(polygon)||polygon.length<3)return false;const signs=polygon.map((a,i)=>{const b=polygon[(i+1)%polygon.length];return (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);});return signs.every(v=>v>=-1e-7)||signs.every(v=>v<=1e-7);}
  function intersectRegions(subject,clip){
    if(!Array.isArray(subject)||!Array.isArray(clip)||subject.length<3||clip.length<3||!subject.every(finitePoint)||!clip.every(finitePoint))return [];
    let result=subject.map(p=>[...p]);const area=clip.reduce((sum,p,i)=>{const q=clip[(i+1)%clip.length];return sum+p[0]*q[1]-q[0]*p[1];},0),winding=area>=0?1:-1;
    for(let i=0;i<clip.length&&result.length;i++){
      const a=clip[i],b=clip[(i+1)%clip.length],side=p=>winding*((b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0])),next=[];
      for(let j=0;j<result.length;j++){const p=result[j],q=result[(j+1)%result.length],from=side(p),to=side(q);if(from>=-1e-7)next.push(p);if((from>=0)!==(to>=0)){const t=from/(from-to);next.push([p[0]+(q[0]-p[0])*t,p[1]+(q[1]-p[1])*t]);}}
      result=next;
    }return result;
  }
  function translated(object,x,y){return object.bounds_cm.map(p=>[p[0]+x-object.x_cm,p[1]+y-object.y_cm]);}
  function snap({moving,objects=[],x,y,project,region,thresholdPx=8,screenScale=1,snapElements=true,snapGrid=false,gridStep=50,bypass=false}){
    const result={x,y,guides:[]};
    if(bypass||typeof project!=='function'||!moving||!bounds(moving.bounds_cm)||![moving.x_cm,moving.y_cm,x,y,screenScale,thresholdPx].every(Number.isFinite)||screenScale<=0)return result;
    const valid=object=>object&&Number.isFinite(object.x_cm)&&Number.isFinite(object.y_cm)&&bounds(object.bounds_cm);
    const fits=(object,cx=object.x_cm,cy=object.y_cm)=>!region||translated(object,cx,cy).every(p=>inside(p,region));
    const others=objects.filter(o=>valid(o)&&o!==moving&&o.id!==moving.id&&fits(o));
    const next=[x,y],threshold=thresholdPx*screenScale;
    for(let axis=0;axis<2;axis++){
      const box=bounds(translated(moving,next[0],next[1])),current=axis===0?[box.minX,(box.minX+box.maxX)/2,box.maxX]:[box.minY,(box.minY+box.maxY)/2,box.maxY],targets=[];
      if(snapElements)for(const other of others){const b=bounds(other.bounds_cm);targets.push(...(axis===0?[b.minX,(b.minX+b.maxX)/2,b.maxX]:[b.minY,(b.minY+b.maxY)/2,b.maxY]));}
      if(snapGrid&&Number.isFinite(gridStep)&&gridStep>=5)for(const anchor of current)targets.push(Math.round(anchor/gridStep)*gridStep);
      let best=null;
      for(const anchor of current)for(const target of targets){
        const candidate=[...next];candidate[axis]+=target-anchor;if(!fits(moving,candidate[0],candidate[1]))continue;
        const from=[(box.minX+box.maxX)/2,(box.minY+box.maxY)/2];from[axis]=anchor;const to=[...from];to[axis]=target;
        let d;try{d=distance(project(from),project(to));}catch{continue;}
        if(Number.isFinite(d)&&d<=threshold&&(!best||d<best.distance-1e-10))best={coordinate:candidate[axis],value:target,distance:d};
      }
      if(best){next[axis]=best.coordinate;result.guides.push({axis:axis===0?'x':'y',value:best.value});}
    }
    result.x=next[0];result.y=next[1];return result;
  }
  function snapInWorld({moving,objects=[],x,y,toWorld=p=>[...p],fromWorld=p=>[...p],...options}){
    if(options.bypass||!moving||!bounds(moving.bounds_cm))return {x,y,guides:[]};
    const convert=object=>{const anchor=toWorld([object.x_cm,object.y_cm]);return {...object,x_cm:anchor[0],y_cm:anchor[1],bounds_cm:object.bounds_cm.map(toWorld)};};
    try{
      const target=toWorld([x,y]),result=snap({...options,moving:convert(moving),objects:objects.filter(object=>bounds(object?.bounds_cm)).map(convert),x:target[0],y:target[1]}),local=fromWorld([result.x,result.y]);
      return finitePoint(local)?{...result,x:local[0],y:local[1]}:{x,y,guides:[]};
    }catch{return {x,y,guides:[]};}
  }
  function draw(overlay,{G,calibration,facade,unit=1,guides=[]}){
    if(!facade?.enabled||!calibration?.target_world_cm)return;
    const polygon=calibration.target_world_cm,box=bounds(polygon);if(!box)return;
    const make=(tag,attrs)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);Object.entries(attrs).forEach(([key,value])=>n.setAttribute(key,value));return n;};
    const group=make('g',{'data-facade-overlay':'true','pointer-events':'none'});
    const line=(a,b,color,width)=>{const clipped=clipSegment(a,b,polygon);if(!clipped)return;try{const points=Array.from({length:33},(_,i)=>{const t=i/32;return G.apply(calibration.worldToImage,[clipped[0][0]+(clipped[1][0]-clipped[0][0])*t,clipped[0][1]+(clipped[1][1]-clipped[0][1])*t]);});group.append(make('polyline',{points:points.map(p=>p.join(',')).join(' '),fill:'none',stroke:color,'stroke-width':width*unit}));}catch{/* Outside the supported projection must not leave a stale guide. */}};
    const step=facade.grid_step_cm;
    if(facade.grid_visible&&step>=5&&(box.maxX-box.minX+box.maxY-box.minY)/step<=160){
      for(let x=Math.ceil(box.minX/step)*step;x<box.maxX;x+=step)line([x,box.minY],[x,box.maxY],'#1b9a8270',1);
      for(let y=Math.ceil(box.minY/step)*step;y<box.maxY;y+=step)line([box.minX,y],[box.maxX,y],'#1b9a8270',1);
    }
    for(const guide of guides)if(guide.points)line(...guide.points,'#d832a5',2);else if(guide.axis==='x')line([guide.value,box.minY],[guide.value,box.maxY],'#d832a5',2);else line([box.minX,guide.value],[box.maxX,guide.value],'#d832a5',2);
    overlay.append(group);
  }
  return {defaults,normalize,bounds,clipSegment,intersectRegions,inside,translated,snap,snapInWorld,draw};
});
