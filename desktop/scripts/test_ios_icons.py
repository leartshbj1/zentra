import json
from pathlib import Path
import struct
import tempfile
import unittest
import plistlib
import zipfile
import zlib
from ios_icons import pixels, prepare, verify_ipa_icons, ICON_ROOT


def png(color=(12, 80, 55), optimized=False, alpha=255, mode=0):
    channels = 4 if optimized else 3
    row = bytes((*color[::-1], alpha) if optimized else color) * 2
    raw = bytearray()
    previous = bytes(len(row))
    for _ in range(2):
        raw.append(mode)
        for x, value in enumerate(row):
            a = row[x-channels] if x >= channels else 0
            b = previous[x];c = previous[x-channels] if x >= channels else 0
            p = a+b-c;distances = (abs(p-a), abs(p-b), abs(p-c))
            paeth = (a,b,c)[distances.index(min(distances))]
            raw.append((value-(0,a,b,(a+b)//2,paeth)[mode])&255)
        previous = row
    def chunk(name, data):return struct.pack('>I',len(data))+name+data+struct.pack('>I',zlib.crc32(name+data))
    compressor = zlib.compressobj(wbits=-15 if optimized else 15)
    return b'\x89PNG\r\n\x1a\n'+(chunk(b'CgBI',b'\x50\x00\x20\x02') if optimized else b'')+chunk(b'IHDR',struct.pack('>IIBBBBB',2,2,8,6 if optimized else 2,0,0,0))+chunk(b'IDAT',compressor.compress(raw)+compressor.flush())+chunk(b'IEND',b'')


class Icons(unittest.TestCase):
    def test_apple_optimized_and_standard_pixels_match_for_every_filter(self):
        for mode in range(5):
            with self.subTest(mode=mode):
                self.assertEqual(pixels(png(mode=mode)),pixels(png(optimized=True,mode=mode)))
                self.assertEqual(pixels(png(mode=mode)),(2,2,bytes((12,80,55))*4))

    def test_rejects_transparency_and_bad_png(self):
        with self.assertRaises(ValueError):pixels(png(optimized=True,alpha=100))
        bad=bytearray(png());bad[-1]^=1
        with self.assertRaises(ValueError):pixels(bytes(bad))

    def test_installs_all_approved_artwork_and_keeps_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            catalog=Path(directory);images=[]
            for source in sorted(ICON_ROOT.glob('*.png')):
                width,height,_=pixels(source.read_bytes())
                images.append({'filename':source.name,'size':f'{width}x{height}','scale':'1x'})
                (catalog/source.name).write_bytes(b'old-default-icon')
            text=json.dumps({'images':images,'info':{'version':1,'author':'xcode'}})
            (catalog/'Contents.json').write_text(text)
            proof=prepare(catalog)
            self.assertEqual(len(proof['icons']),18)
            self.assertEqual((catalog/'Contents.json').read_text(),text)
            for source in ICON_ROOT.glob('*.png'):self.assertEqual((catalog/source.name).read_bytes(),source.read_bytes())

    def test_bad_catalog_does_not_partly_replace_existing_icons(self):
        with tempfile.TemporaryDirectory() as directory:
            catalog=Path(directory);name='AppIcon-60x60@2x.png';target=catalog/name;target.write_bytes(b'old')
            for invalid in ['../outside.png','missing.png',name]:
                images=[{'filename':name,'size':'60x60','scale':'2x'},{'filename':invalid,'size':'60x60','scale':'2x'}]
                (catalog/'Contents.json').write_text(json.dumps({'images':images}))
                with self.assertRaises((ValueError,FileNotFoundError)):prepare(catalog)
                self.assertEqual(target.read_bytes(),b'old')

    def test_rejects_a_packaged_default_icon_even_when_version_is_correct(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);ipa=root/'test.ipa'
            for name in ['AppIcon-60x60@2x.png','AppIcon-76x76@2x.png']:(root/name).write_bytes(png())
            for color,expected in [((12,80,55),True),((255,255,255),False)]:
                with zipfile.ZipFile(ipa,'w') as archive:
                    archive.writestr('Payload/Zentra.app/Info.plist',plistlib.dumps({'CFBundleShortVersionString':'1.90.6','CFBundleIcons':{'CFBundlePrimaryIcon':{'CFBundleIconName':'AppIcon'}}}))
                    archive.writestr('Payload/Zentra.app/Assets.car',b'catalog-fixture')
                    for name in ['AppIcon60x60@2x.png','AppIcon76x76@2x~ipad.png']:archive.writestr('Payload/Zentra.app/'+name,png(color,optimized=True))
                if expected:self.assertEqual(len(verify_ipa_icons(ipa,root)),2)
                else:
                    with self.assertRaisesRegex(ValueError,'differs from Zentra'):verify_ipa_icons(ipa,root)


if __name__ == '__main__': unittest.main()
