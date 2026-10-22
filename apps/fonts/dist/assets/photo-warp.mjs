export function quadMap(p) {
  const [p0,p1,p2,p3]=p;
  const dx1=p1.x-p2.x, dx2=p3.x-p2.x, dx3=p0.x-p1.x+p2.x-p3.x;
  const dy1=p1.y-p2.y, dy2=p3.y-p2.y, dy3=p0.y-p1.y+p2.y-p3.y;
  const det=dx1*dy2-dx2*dy1;
  const g=(dx3*dy2-dx2*dy3)/det, h=(dx1*dy3-dx3*dy1)/det;
  return (u,v)=>({x:((p1.x-p0.x+g*p1.x)*u+(p3.x-p0.x+h*p3.x)*v+p0.x)/(g*u+h*v+1),
    y:((p1.y-p0.y+g*p1.y)*u+(p3.y-p0.y+h*p3.y)*v+p0.y)/(g*u+h*v+1)});
}
export function validQuad(p) {
  return p.every((a,i)=>{const b=p[(i+1)%4],c=p[(i+2)%4];return (b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x)>16;});
}
function triangle(ctx,img,src,dst) {
  const [a,b,c]=src,[A,B,C]=dst;
  const d=(b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y);
  if(Math.abs(d)<1e-8)return;
  const xx=((B.x-A.x)*(c.y-a.y)-(C.x-A.x)*(b.y-a.y))/d;
  const xy=((C.x-A.x)*(b.x-a.x)-(B.x-A.x)*(c.x-a.x))/d;
  const yx=((B.y-A.y)*(c.y-a.y)-(C.y-A.y)*(b.y-a.y))/d;
  const yy=((C.y-A.y)*(b.x-a.x)-(B.y-A.y)*(c.x-a.x))/d;
  // Slightly overlap triangle clips to prevent antialias seams through letters.
  const corners=[A,B,C];
  const normals=corners.map((p,i)=>{const q=corners[(i+1)%3],len=Math.hypot(q.x-p.x,q.y-p.y);return {x:(q.y-p.y)/len,y:-(q.x-p.x)/len};});
  const clip=corners.map((p,i)=>{const n=normals[i],prev=normals[(i+2)%3],f=.55/Math.max(.001,1+n.x*prev.x+n.y*prev.y);return {x:p.x+(n.x+prev.x)*f,y:p.y+(n.y+prev.y)*f};});
  ctx.save();ctx.beginPath();ctx.moveTo(clip[0].x,clip[0].y);ctx.lineTo(clip[1].x,clip[1].y);ctx.lineTo(clip[2].x,clip[2].y);ctx.closePath();ctx.clip();
  ctx.transform(xx,yx,xy,yy,A.x-xx*a.x-xy*a.y,A.y-yx*a.x-yy*a.y);ctx.drawImage(img,0,0);ctx.restore();
}
export function drawWarp(ctx,img,points) {
  if(Math.hypot(points[0].x-points[1].x+points[2].x-points[3].x,points[0].y-points[1].y+points[2].y-points[3].y)<.001){
    ctx.save();ctx.transform((points[1].x-points[0].x)/img.width,(points[1].y-points[0].y)/img.width,(points[3].x-points[0].x)/img.height,(points[3].y-points[0].y)/img.height,points[0].x,points[0].y);ctx.drawImage(img,0,0);ctx.restore();return;
  }
  const map=quadMap(points),n=12;
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const uv=[[i/n,j/n],[(i+1)/n,j/n],[(i+1)/n,(j+1)/n],[i/n,(j+1)/n]];
    const src=uv.map(([u,v])=>({x:u*img.width,y:v*img.height})),dst=uv.map(([u,v])=>map(u,v));
    triangle(ctx,img,[src[0],src[1],src[2]],[dst[0],dst[1],dst[2]]);
    triangle(ctx,img,[src[0],src[2],src[3]],[dst[0],dst[2],dst[3]]);
  }
}
