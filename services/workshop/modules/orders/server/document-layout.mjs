const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const box=value=>plain(value)&&Object.keys(value).every(key=>['page','x','y','width','height'].includes(key))&&Number.isInteger(value.page)&&value.page>=0&&['x','y','width','height'].every(key=>typeof value[key]==='number'&&Number.isFinite(value[key]))&&value.x>=0&&value.y>=0&&value.width>0&&value.height>0;
export function validDocumentLayout(layout) {
  if(!plain(layout)||layout.version!==1||layout.unit!=='pt'||layout.origin!=='top-left'||!Array.isArray(layout.pages)||!layout.pages.length||layout.pages.length>2000||!plain(layout.anchors))return false;
  if(Object.keys(layout).some(key=>!['version','unit','origin','pages','anchors','pdfSha256'].includes(key)))return false;
  if(layout.pdfSha256!==undefined&&!/^[a-f0-9]{64}$/.test(layout.pdfSha256))return false;
  if(layout.pages.some((page,index)=>!plain(page)||page.index!==index||!Number.isFinite(page.width)||!Number.isFinite(page.height)||page.width<10||page.height<10||page.width>5000||page.height>5000))return false;
  if(Object.keys(layout.anchors).some(key=>!['sellerSignature','sellerStamp','buyerSignature'].includes(key)))return false;
  for(const anchor of Object.values(layout.anchors)) {
    if(!box(anchor))return false;const page=layout.pages[anchor.page];
    if(!page||anchor.x+anchor.width>page.width+.01||anchor.y+anchor.height>page.height+.01)return false;
  }
  return Boolean(layout.anchors.sellerSignature&&layout.anchors.sellerStamp);
}
