"""Money, provenance, frozen downloads and HTTP authorization. Never calls AI."""
import copy
import hashlib
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock

import commercial_proposal as cp
import editor_auth
import production_spec
import render_server
import test_production_spec


class Offers(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.job = 'proposal-fixture-complete-01'
        self.folder = self.root / 'jobs' / self.job
        self.folder.mkdir(parents=True)
        project, report, image = test_production_spec.ProductionSpecTests().fixture()
        project['products'][0].update(module_version=1,template_id='letters-standard',template_version=1)
        obj = project['products'][0]['params']['objects'][0]
        obj.update(type='text', text='АБ', height_basis='body', letter_height_cm=50, front_color='#ffffff')
        raw = json.dumps(project, ensure_ascii=False).encode()
        (self.folder/'project.json').write_bytes(raw)
        (self.folder/'production-spec.json').write_text(json.dumps(production_spec.build(project, report, raw)), encoding='utf-8')
        for name in ('render.png','source.png'):
            (self.folder/name).write_bytes(image)
        self.service = Mock()
        self.service.output = self.root/'jobs'
        self.service.public.return_value = {'status':'complete','project_id':'frozen-project'}
        self.service.artifact.side_effect = lambda job,name:self.folder/name

    def tearDown(self):
        self.temp.cleanup()

    def test_exact_artwork_and_project_hash_required(self):
        model = cp.source(self.service,self.job)
        self.assertEqual(model['objects'][0]['letter_height'],50)
        self.assertEqual(model['objects'][0]['height'],51.44032875514375)
        self.assertEqual(model['pricing']['min'],1200000)
        spec=json.loads((self.folder/'production-spec.json').read_bytes())
        spec['objects'][0]['source_input']['artwork']['sha256']='0'*64
        (self.folder/'production-spec.json').write_text(json.dumps(spec),encoding='utf-8')
        with self.assertRaises(cp.ProposalError): cp.source(self.service,self.job)
        (self.folder/'project.json').write_text('{}',encoding='utf-8')
        with self.assertRaises(cp.ProposalError): cp.source(self.service,self.job)

    def test_tariff_boundaries_and_graphemes_use_real_engine(self):
        base=cp.source(self.service,self.job)['objects'][0]
        for height,rate in [(14.99,150),(15,100),(50,100),(50.01,150)]:
            obj=base|{'letter_height':height,'height':70,'text':'Е\u0308🚗 24'}
            row=cp.calculate([obj])['rows'][0]['letterRows'][0]
            self.assertEqual(row['count'],4)
            self.assertEqual(row['rate'],rate)
            self.assertEqual(row['costCents'],round(4*height*rate*100))

    def test_independent_supports_and_missing_prices(self):
        model=cp.source(self.service,self.job)
        p=cp.calculate(model['objects']*4)
        self.assertEqual((p['min'],p['max']),(4800000,6400000))
        unknown=model['objects'][0]|{'priceable':False}
        p=cp.calculate([unknown])
        self.assertFalse(p['complete'])
        self.assertEqual(p['rows'],[None])
        opts=cp.options({'prototype':0,'installation':None})
        self.assertEqual(opts['prototype'],0)
        self.assertIsNone(opts['installation'])
        for value in (-1,True,float('nan'),float('inf'),'1000'):
            with self.assertRaises(cp.ProposalError):cp.options({'prototype':value})

    def test_build_freezes_three_downloads_without_source_changes(self):
        before={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in self.folder.iterdir()}
        result=cp.create(self.service,{'job_id':self.job,'options':{'prototype':6000,'installation':24000,'delivery':4000}})
        self.assertEqual(len(result['files']),3)
        for f in result['files']:
            data=cp.download(self.service,result['id'],f['filename'])
            self.assertTrue(data.startswith(b'%PDF-'))
            self.assertEqual(hashlib.sha256(data).hexdigest(),f['sha256'])
        self.assertEqual(before,{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in self.folder.iterdir()})
        target=self.root/result['files'][0]['url']
        target.write_bytes(b'changed')
        with self.assertRaises(cp.ProposalError):cp.download(self.service,result['id'],'presentation.pdf')
        with self.assertRaises(FileNotFoundError):cp.download(self.service,'../jobs','presentation.pdf')

    def test_http_requires_session_token_origin_and_returns_pdf(self):
        auth=editor_auth.PasswordAuth(editor_auth.make_config('qa-secret',cookie_path='/signs/'))
        server=render_server.create_server(0,self.root/'jobs',status_reader=lambda:{'configured':True})
        server.auth=auth
        server.service.public=self.service.public
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        cookie=auth.session_cookie().split(';')[0]
        host=f'127.0.0.1:{server.server_port}'
        def request(method,path,body=None,authenticated=False,token=False,origin=None):
            conn=http.client.HTTPConnection('127.0.0.1',server.server_port)
            headers={'Content-Type':'application/json'}
            if authenticated:headers['Cookie']=cookie
            if token:headers['X-Editor-Token']=server.service.token
            if origin:headers['Origin']=origin
            conn.request(method,path,json.dumps(body) if body is not None else None,headers)
            response=conn.getresponse();status=response.status;data=response.read();mime=response.getheader('Content-Type');conn.close()
            return status,data,mime
        try:
            self.assertEqual(request('GET','/proposals.html')[0],303)
            self.assertEqual(request('GET','/proposals.html',authenticated=True)[0],200)
            self.assertEqual(request('POST','/api/proposals',{},True,False)[0],403)
            self.assertEqual(request('POST','/api/proposals',{},True,True,'https://evil.example')[0],403)
            status,data,_=request('POST','/api/proposals',{'job_id':self.job,'style':'compact'},True,True)
            self.assertEqual(status,201,data)
            result=json.loads(data);url='/'+result['files'][0]['url']
            self.assertEqual(request('GET',url)[0],303)
            status,data,mime=request('GET',url,authenticated=True)
            self.assertEqual(status,200);self.assertEqual(mime,'application/pdf');self.assertTrue(data.startswith(b'%PDF-'))
        finally:
            server.shutdown();server.server_close();thread.join(5)


if __name__=='__main__':unittest.main()
