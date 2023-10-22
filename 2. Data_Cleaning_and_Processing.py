import pandas as pd

# specify the file path for the original CSV file
input_file_path = 'covid_data.csv'

# specify the file path for the cleaned CSV file
output_file_path = 'cleaned_covid_data.csv'

# read the CSV file into a pandas DataFrame
df = pd.read_csv(input_file_path)

# drop any rows with missing values
df.dropna(inplace=True)

# rename the columns to remove underscores and make them more readable
df.rename(columns={
    'Date_reported': 'Date Reported',
    'Country_code': 'Country Code',
    'Country': 'Country Name',
    'WHO_region': 'WHO Region',
    'New_cases': 'New Cases',
    'Cumulative_cases': 'Cumulative Cases',
    'New_deaths': 'New Deaths',
    'Cumulative_deaths': 'Cumulative Deaths'
}, inplace=True)

# convert the 'Date Reported' column to a datetime object
df['Date Reported'] = pd.to_datetime(df['Date Reported'])

# set the 'Date Reported' column as the DataFrame's index
df.set_index('Date Reported', inplace=True)

# convert the 'New Cases' and 'New Deaths' columns to integers
df['New Cases'] = df['New Cases'].astype(int)
df['New Deaths'] = df['New Deaths'].astype(int)

# save the cleaned data to a new CSV file
df.to_csv(output_file_path)

# display a message confirming the successful save
print(f"Cleaned data saved to {output_file_path}")