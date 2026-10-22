/* Local prototype harness; excluded from the future production release. */
(async () => {
  'use strict';
  const $ = id => document.getElementById(id);
  const guard = () => {
    ['generate','launchCorel','exportCorel','resumeGeneration'].forEach(id => {if($(id))$(id).disabled=true;});
    if($('connectionMessage'))$('connectionMessage').textContent='Локальный прототип. Здесь можно проверить эскиз и сохранить проект; генерация и CorelDRAW появятся при внедрении.';
  };
  document.addEventListener('signage:change',guard);
  await window.SignageDraft.ready;
  await window.SignageInterface.ready;
  async function loadExample(){
    await $('demo').onclick();
    if(window.SignageEditor.snapshot().hasPhoto){
      $('signWidth').value='240';$('signHeight').value='90';
      const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;
      const c=canvas.getContext('2d');c.strokeStyle='#fff3dc';c.lineWidth=14;c.lineCap='round';c.lineJoin='round';
      c.beginPath();c.moveTo(47,92);c.lineTo(182,92);c.lineTo(169,192);c.quadraticCurveTo(116,218,60,192);c.closePath();c.stroke();
      c.beginPath();c.moveTo(181,111);c.bezierCurveTo(240,110,225,169,174,166);c.stroke();
      c.beginPath();c.moveTo(39,223);c.lineTo(203,223);c.stroke();
      for(const x of [88,124,159]){c.beginPath();c.moveTo(x,67);c.bezierCurveTo(x-17,47,x+17,35,x,15);c.stroke();}
      window.SignageLetterUI.restore({objects:[
        {id:'demo-title',type:'text',text:'КОФЕ',font_family:'Arial Black',font_bold:true,letter_height_cm:24,line_gap_cm:4,text_align:'left',front_color:'#fff3dc',x_cm:90,y_cm:10,rotation_deg:0,depth_cm:5,side_color:'#292f30',brief:''},
        {id:'demo-details',type:'text',text:'с собой\nкаждый день',font_family:'Georgia',font_bold:false,letter_height_cm:10,line_gap_cm:4,text_align:'right',front_color:'#fff3dc',x_cm:125,y_cm:44,rotation_deg:0,depth_cm:3,side_color:'#292f30',brief:''},
        {id:'demo-logo',type:'logo',artwork:{mime_type:'image/png',name:'Логотип-пример.png',source:'uploaded',width_px:256,height_px:256,data_url:canvas.toDataURL('image/png')},width_cm:42,x_cm:15,y_cm:20,rotation_deg:0,depth_cm:5,side_color:'#292f30',brief:''}
      ]});
      window.SignageLetterUI.select('demo-title');
      window.SignageEditor.render();await window.SignageDraft.flush();
      localStorage.setItem('letter-prototype-demo-seeded-v2','1');
    }
  }
  $('letterPrototypeDemo').onclick=loadExample;
  if(!window.SignageEditor.snapshot().hasPhoto||!localStorage.getItem('letter-prototype-demo-seeded-v2'))await loadExample();
  window.SignageInterface.setStep('3');guard();
})();
