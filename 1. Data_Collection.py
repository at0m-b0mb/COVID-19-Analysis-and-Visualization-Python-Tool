import requests

# specify the URL for the data you want to collect
url = 'https://covid19.who.int/WHO-COVID-19-global-data.csv'

# use requests library to make a GET request to the URL and retrieve the data
response = requests.get(url)

# check if the request was successful
if response.status_code == 200:
    # retrieve the data from the response object
    data = response.content
    # save the data to a file
    with open('covid_data.csv', 'wb') as file:
        file.write(data)
    print('Data saved to covid_data.csv')
else:
    print('Error retrieving data. Status code:', response.status_code)
