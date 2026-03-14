from OpenSSL import crypto

def create_self_signed_cert():
    # 키 생성
    key = crypto.PKey()
    key.generate_key(crypto.TYPE_RSA, 2048)

    # 인증서 생성
    cert = crypto.X509()
    cert.get_subject().CN = "*"
    cert.set_serial_number(1000)
    cert.gmtime_adj_notBefore(0)
    cert.gmtime_adj_notAfter(365*24*60*60)  # 1년 유효
    cert.set_issuer(cert.get_subject())
    cert.set_pubkey(key)
    cert.sign(key, 'sha256')

    # 파일로 저장
    with open("cert.pem", "wb") as f:
        f.write(crypto.dump_certificate(crypto.FILETYPE_PEM, cert))
    with open("key.pem", "wb") as f:
        f.write(crypto.dump_privatekey(crypto.FILETYPE_PEM, key))

if __name__ == '__main__':
    create_self_signed_cert()